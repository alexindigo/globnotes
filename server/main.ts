// SPDX-License-Identifier: LGPL-3.0-only

/**
 * globnotes server entry point (Deno/TypeScript).
 *
 * @pathfinder/pathfinder owns routing: filesystem-routed endpoints
 * (server/api/endpoints/), an app-wide auth middleware (_/00-auth.ts),
 * a root crossing-rest catch-all for vault files and note pages, and a
 * package-owned /_status ops face. A thin wrapper first applies host
 * admission (GLOBNOTES_ALLOWED_HOSTS, server/host_admission.ts) to every
 * request, then re-homes the configured path prefix onto each Request
 * before the app sees it.
 */

import { pathfinder } from "@pathfinder/pathfinder";
import * as path from "@std/path";
import { LocalAuth } from "./auth/local.ts";
import { FileServing } from "./files/file_serving.ts";
import { FileSystemNotes } from "./notes/file_system.ts";
import { NoteOperations } from "./notes/operations.ts";
import { VaultHub } from "./hub/hub.ts";
import { VaultEffects } from "./hub/effects.ts";
import { HubGate } from "./hub/gate.ts";
import { subscribeExternalFacts, subscribeIndex } from "./hub/subscribers.ts";
import { PluginActions } from "./plugins/actions.ts";
import { AuxiliaryFilesystem } from "./plugins/auxiliary_fs.ts";
import { PluginDataStore } from "./plugins/data.ts";
import { PluginEndpoints } from "./plugins/endpoints.ts";
import { PluginLifecycle } from "./plugins/lifecycle.ts";
import { PluginManager } from "./plugins/manager.ts";
import { servicePluginRpc } from "./plugins/rpc.ts";
import { AuthType, GlobalConfig } from "./config.ts";
import { getEnv, rewriteIndexHtml } from "./helpers.ts";
import { admitHost, createRebindingWarner } from "./host_admission.ts";
import { logger } from "./logger.ts";
import { createMcpEndpoint } from "./mcp/endpoint.ts";
import { createRateLimiter } from "./mcp/rate_limit.ts";
import { initState, state } from "./state.ts";
import { Fts5Indexer } from "./search/fts5.ts";
import { readAppVersion } from "./version.ts";
import { formatVersion } from "../shared/version.ts";

function fileExists(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

// Release identity first: a missing or invalid VERSION/GLOBNOTES_REVISION
// stops startup before anything else is touched.
const appVersion = readAppVersion();
logger.info(`globnotes ${formatVersion(appVersion)}`);

const globalConfig = new GlobalConfig();
const environment = globalConfig.environment;
// One effects owner for the vault; vault effects run only inside the gate.
const effects = new VaultEffects(globalConfig.notesPath);
const notes = new FileSystemNotes(
  globalConfig.notesPath,
  {},
  environment,
  effects,
);
const indexer = new Fts5Indexer(globalConfig.statePath, environment);
const fileServing = new FileServing(globalConfig.notesPath, effects);
const hub = new VaultHub(
  globalConfig.notesPath,
  globalConfig.statePath,
  environment,
);
const gate = new HubGate({ hub });
const plugins = new PluginManager(
  globalConfig.notesPath,
  undefined,
  undefined,
  globalConfig.statePath,
  {
    // All worker roles (including legacy render replicas) go write:false
    // while setup is pending or the vault is read-only.
    renderWritable: () => state.lifecycle?.writable() ?? true,
    // Policy writes commit through the short policy gate (wired below).
    persistence: {
      commit: (effect) => state.lifecycle!.gate.run(effect),
    },
    env: environment,
  },
);
const auth = globalConfig.authType === AuthType.PASSWORD ||
    globalConfig.authType === AuthType.TOTP
  ? new LocalAuth(globalConfig)
  : null;
initState(globalConfig, auth, notes, indexer, fileServing, plugins, hub);

// Guarded-operation bundle: lifecycle (epochs/gates) → operations facade →
// deferred action queue → authoritative service runtime. Service
// contributions start after setup completes, independent of rendering or
// browser login; pure rendering stays lazy.
const lifecycle = new PluginLifecycle(globalConfig);
const operations = new NoteOperations({
  notes,
  files: fileServing,
  indexer,
  hub,
  gate,
  runtime: () => plugins.runtime,
  lifecycle,
});
const actions = new PluginActions({
  operations,
  runtime: () => plugins.runtime,
  vaultPath: globalConfig.notesPath,
  statePath: globalConfig.statePath,
});
state.version = appVersion;
state.lifecycle = lifecycle;
state.operations = operations;
state.actions = actions;
// Host control services: committed settings/data persistence (with owner
// notification) and the sandbox endpoint router.
const pluginData = new PluginDataStore(globalConfig.statePath, {
  commit: (effect) => lifecycle.gate.run(effect),
  settingsSchema: (id) => plugins.network.settingsSchema(id),
  settingsContext: (id) => plugins.network.settingsContext(id),
  settingsEnvironment: plugins.settingsEnvironment,
  prepareSettingsCommit: (change) =>
    plugins.network.prepareSettingsCommit(change),
  settingsChanged: (id, page, revision) => {
    plugins.runtime?.settingsChanged(id, page, revision);
  },
});
state.pluginData = pluginData;
const auxiliaryFilesystem = new AuxiliaryFilesystem({
  vaultPath: globalConfig.notesPath,
  statePath: globalConfig.statePath,
  operational: () => lifecycle.operational(),
  writable: () => lifecycle.writable(),
  settings: (manifest) =>
    pluginData.forPlugin(manifest.id).settingsLease(manifest.settings),
  commit: (effect) => lifecycle.gate.run(effect),
  effects,
  gate,
});
state.pluginEndpoints = new PluginEndpoints(() => plugins.runtime);
state.pluginNetwork = plugins.network;
// The MCP endpoint (docs/mcp.md): the same authentication, write path and
// plugin guards as the REST API. Disabled, /_/mcp answers 404.
state.mcp = globalConfig.mcpEnabled
  ? createMcpEndpoint({
    rateLimiter: createRateLimiter({ perMinute: globalConfig.mcpRateLimit }),
  })
  : null;
lifecycle.onFact((fact) => {
  const runtime = plugins.runtime;
  if (!runtime) return;
  if (fact.action === "operation-error") {
    runtime.post("on-operation-error", fact, {
      operationId: fact.operationId,
      action: "operation-error",
    });
    return;
  }
  runtime.post(`on-${fact.action}` as never, fact, {
    operationId: fact.operationId,
    action: fact.action,
  });
});
lifecycle.onSync((fact) => {
  plugins.syncAll(fact).catch((e) =>
    logger.error(`plugin sync delivery failed: ${e}`)
  );
});
plugins.configureRuntime({
  operational: () => lifecycle.operational(),
  writable: () => lifecycle.writable(),
  commit: (effect) => lifecycle.gate.run(effect),
  sanitizeFact: (manifest, fact) =>
    lifecycle.applyReadGrants(manifest, fact as never),
  changed: () => lifecycle.notifyInvalidation(),
  rpc: servicePluginRpc({
    vaultPath: globalConfig.notesPath,
    statePath: globalConfig.statePath,
    actions: () => actions,
    filesystem: auxiliaryFilesystem,
  }),
});
if (!globalConfig.setupRequired) {
  plugins.runtime?.reconcile().catch((e) =>
    logger.error(`plugin runtime reconciliation failed: ${e}`)
  );
}
hub.start();
subscribeIndex(hub, indexer);
subscribeExternalFacts(hub, lifecycle);
indexer.startBackgroundSync();
// Render pools still start lazily on the first render call.

// Publish the path prefix into the built client before serving it
// (Python: rewrite_index_html at import). Only when the client build
// exists — dev checkouts run the server alone.
try {
  rewriteIndexHtml(
    "client/dist/index.html",
    globalConfig.pathPrefix,
    globalConfig.brandName,
  );
} catch {
  logger.debug("client/dist/index.html not present; skipping rewrite.");
}

// One-time Whoosh → FTS5 migration: old segment files serve no purpose.
const globDir = globalConfig.statePath;
try {
  for (const entry of Deno.readDirSync(globDir)) {
    if (
      entry.isFile &&
      (entry.name.endsWith(".seg") || entry.name.endsWith(".toc") ||
        entry.name === "WRITELOCK")
    ) {
      Deno.removeSync(`${globDir}/${entry.name}`);
    }
  }
} catch {
  // .globnotes doesn't exist yet — first boot
}

// Relocated state dir but a legacy vault: warn loudly with the exact
// move; never auto-copy (partial cross-filesystem copies of credentials
// are the failure mode).
if (
  getEnv("GLOBNOTES_INDEX_PATH", {}, environment) &&
  !fileExists(path.join(globalConfig.statePath, "config.json")) &&
  fileExists(path.join(globalConfig.notesPath, ".globnotes", "config.json"))
) {
  logger.warning(
    "GLOBNOTES_INDEX_PATH is set but the state dir has no config.json — " +
      "the vault still holds it. Move the existing state with:\n" +
      `  mv ${path.join(globalConfig.notesPath, ".globnotes")}/* ` +
      `${globalConfig.statePath}/`,
  );
}

if (globalConfig.setupRequired) {
  logger.info("First-run setup required. Open the web UI to complete setup.");
} else if (globalConfig.authType === AuthType.NONE) {
  logger.warning(
    "globnotes is running with NO authentication. Anyone who can " +
      "reach this server can read and modify notes.",
  );
}
// DNS-rebinding exposure (server/host_admission.ts): checked now and after
// every access-policy change, so a first-run setup or an access-settings
// change to none/read_only without GLOBNOTES_ALLOWED_HOSTS warns too.
const rebindingWarner = createRebindingWarner((message) =>
  logger.warning(message)
);
rebindingWarner.update(state.config);
lifecycle.onPolicyChange(() => rebindingWarner.update(state.config));
if (auth?.isTotpEnabled && auth.totpKeyFromEnv) {
  // Env-configured keys enrol via this log line — their only channel.
  // Wizard-enrolled keys were already recorded in the UI; printing them
  // here would leave key material in the logs for no reason.
  await auth.displayTotpEnrolment();
}

const hostname = getEnv("GLOBNOTES_HOST", { default: "0.0.0.0" }, environment);
const port = Number(
  getEnv("GLOBNOTES_PORT", { castInt: true, default: 8080 }, environment),
);
const prefix = globalConfig.pathPrefix;

const app = await pathfinder({
  roots: [new URL("./api/endpoints/", import.meta.url)],
});

const allowedHosts = globalConfig.allowedHosts;
const httpServer = Deno.serve({ hostname, port }, (req, info) => {
  // Host admission first: one check for every route (server/host_admission.ts).
  const misdirected = admitHost(allowedHosts, req);
  if (misdirected) return misdirected;
  if (!prefix) return app(req, info);
  const url = new URL(req.url);
  // Exact segment matching: /notes-other is NOT the /notes app.
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) {
    return Response.json({ detail: "Not Found" }, { status: 404 });
  }
  const stripped = url.pathname.slice(prefix.length) || "/";
  const target = new URL(stripped, url.origin);
  // The prefix wrapper must preserve the query — plugin APIs depend on it.
  target.search = url.search;
  return app(new Request(target, req), info);
});
// The bound port: equal to GLOBNOTES_PORT, or the OS-assigned one when that
// is 0 (test launchers read it from this line).
const boundPort = (httpServer.addr as Deno.NetAddr).port;
logger.info(
  `globnotes listening on http://${hostname}:${boundPort}${globalConfig.pathPrefix}`,
);
