// SPDX-License-Identifier: LGPL-3.0-only

/**
 * globnotes server entry point (Deno/TypeScript).
 *
 * @pathfinder/pathfinder owns routing: filesystem-routed endpoints
 * (server/api/endpoints/), an app-wide auth middleware (_/00-auth.ts),
 * a root crossing-rest catch-all for vault files and note pages, and a
 * package-owned /_status ops face. A thin wrapper first applies host
 * admission (GLOBNOTES__SERVER_ALLOWEDHOSTS, server/host_admission.ts) to every
 * request, then re-homes the configured path prefix onto each Request
 * before the app sees it.
 */

import { pathfinder } from "@pathfinder/pathfinder";
import { openInstanceIdentity } from "./auth/instance.ts";
import { FileServing } from "./files/file_serving.ts";
import { FileSystemNotes } from "./notes/file_system.ts";
import { NoteOperations } from "./notes/operations.ts";
import { VaultHub } from "./hub/hub.ts";
import { VaultEffects } from "./hub/effects.ts";
import { HubGate } from "./hub/gate.ts";
import { subscribeExternalFacts, subscribeIndex } from "./hub/subscribers.ts";
import { DriverSupervisor } from "./hub/drivers/supervisor.ts";
import { MetadataProjection } from "./metadata/projection.ts";
import { PluginActions } from "./plugins/actions.ts";
import { AuxiliaryFilesystem } from "./plugins/auxiliary_fs.ts";
import { PluginDataStore } from "./plugins/data.ts";
import { PluginEndpoints } from "./plugins/endpoints.ts";
import { PluginManager } from "./plugins/manager.ts";
import { servicePluginRpc } from "./plugins/rpc.ts";
import { GlobalConfig } from "./config.ts";
import { rewriteIndexHtml } from "./helpers.ts";
import { admitHost, createRebindingWarner } from "./host_admission.ts";
import { withRequestBodyLifetime } from "./http_request.ts";
import { initializeLogger, logger } from "./logger.ts";
import { config, configuration } from "./config/loader.ts";
import {
  singleVaultBindings,
  singleVaultSettings,
} from "./config/single_vault.ts";
import { pluginSettings, serviceSettings } from "./config/consumers.ts";
import { snapshotEnvironment } from "./environment.ts";
import { createMcpEndpoint, identityMcpCaller } from "./mcp/endpoint.ts";
import { createRateLimiter } from "./mcp/rate_limit.ts";
import { initState, state } from "./state.ts";
import { Fts5Indexer } from "./search/fts5.ts";
import { type AppVersion, readAppVersion } from "./version.ts";
import { formatVersion } from "../shared/version.ts";

// Release identity first: a missing or invalid VERSION/GLOBNOTES_REVISION
// stops startup before anything else is touched.
const environment = snapshotEnvironment();
let appVersion: AppVersion,
  globalConfig: GlobalConfig,
  services: ReturnType<typeof serviceSettings>;
try {
  appVersion = readAppVersion({ env: { get: (key) => environment[key] } });
  const instance = config({ env: environment, vaults: singleVaultBindings });
  globalConfig = new GlobalConfig(
    singleVaultSettings(configuration(), environment),
  );
  services = serviceSettings(instance);
} catch (error) {
  console.error((error as Error).message);
  Deno.exit(1);
}
// One effects owner for the vault; vault effects run only inside the gate.
const effects = new VaultEffects(globalConfig.notesPath);
const notes = new FileSystemNotes(
  globalConfig.notesPath,
  {},
  services.notes,
  effects,
);
const plugins = new PluginManager(
  globalConfig.notesPath,
  undefined,
  undefined,
  globalConfig.statePath,
  {
    // All worker roles (including legacy render replicas) go write:false
    // until initialized service ownership is available.
    renderWritable: () => state.lifecycle?.writable() ?? false,
    // Policy writes commit through the short policy gate (wired below).
    persistence: {
      commit: (effect) => state.lifecycle!.gate.run(effect),
    },
    settings: pluginSettings(
      globalConfig.resolved.instance,
      globalConfig.resolved.vault.capture().resolved,
    ),
  },
);
try {
  plugins.validateConfiguration();
} catch (error) {
  console.error((error as Error).message);
  Deno.exit(1);
}
initializeLogger(globalConfig.resolved.instance.log.level);
logger.info(`globnotes ${formatVersion(appVersion)}`);
let identity: Awaited<ReturnType<typeof openInstanceIdentity>>;
try {
  globalConfig.resolved.vault.prepareParents();
  identity = await openInstanceIdentity(
    globalConfig,
    () => plugins,
    appVersion,
  );
} catch (error) {
  console.error((error as Error).message);
  Deno.exit(1);
}
const indexer = new Fts5Indexer(globalConfig.statePath, services.index);
const fileServing = new FileServing(globalConfig.notesPath, effects);
const hub = new VaultHub(
  globalConfig.notesPath,
  globalConfig.statePath,
  services.hub,
);
const gate = new HubGate({ hub, versioning: () => plugins.runtime });
initState(globalConfig, identity, notes, indexer, fileServing, plugins, hub);

// Guarded-operation bundle: lifecycle (epochs/gates) → operations facade →
// deferred action queue → authoritative service runtime. Service
// contributions start after setup completes, independent of rendering or
// browser login; pure rendering stays lazy.
const lifecycle = identity.composition.lifecycle;
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
    callerAccess: identityMcpCaller(identity.composition.auth),
    rateLimiter: createRateLimiter({ perMinute: globalConfig.mcpRateLimit }),
  })
  : null;
lifecycle.onFact((fact, viewer) => {
  const runtime = plugins.runtime;
  if (!runtime) return;
  if (fact.action === "operation-error") {
    runtime.post(
      "on-operation-error",
      fact,
      {
        operationId: fact.operationId,
        action: "operation-error",
      },
      undefined,
      { viewer },
    );
    return;
  }
  runtime.post(
    `on-${fact.action}` as never,
    fact,
    {
      operationId: fact.operationId,
      action: fact.action,
    },
    undefined,
    { viewer },
  );
});
lifecycle.onSync((fact, viewer) => {
  plugins.syncAll(fact, viewer).catch((e) =>
    logger.error(`plugin sync delivery failed: ${e}`)
  );
});
const metadata = new MetadataProjection(hub);
state.metadata = metadata;
plugins.configureRuntime({
  hub,
  metadata,
  operational: () => lifecycle.operational(),
  writable: () => lifecycle.writable(),
  commit: (effect) => lifecycle.gate.run(effect),
  sanitizeFact: (manifest, fact) =>
    lifecycle.applyReadGrants(manifest, fact as never),
  changed: (domain) => lifecycle.notifyInvalidation(domain),
  rpc: servicePluginRpc({
    vaultPath: globalConfig.notesPath,
    statePath: globalConfig.statePath,
    actions: () => actions,
    filesystem: auxiliaryFilesystem,
    metadata,
  }),
});
hub.start();
subscribeIndex(hub, indexer);
subscribeExternalFacts(hub, lifecycle);
const drivers = new DriverSupervisor({ hub, operations, plugins, lifecycle });
state.drivers = drivers;
plugins.configureDrivers(drivers);
if (!identity.bootstrap.status().setupRequired) {
  plugins.reconcileOwners().catch(() =>
    logger.error("plugin owner reconciliation failed")
  );
}
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

if (identity.bootstrap.status().setupRequired) {
  logger.info("First-run setup required. Open the web UI to complete setup.");
}
// DNS-rebinding exposure (server/host_admission.ts): checked now and after
// every access-policy change, including setup and Everybody else changes.
const rebindingWarner = createRebindingWarner((message) =>
  logger.warning(message)
);
const updateExposure = () =>
  rebindingWarner.update({
    setupRequired: identity.bootstrap.status().setupRequired,
    everybody: identity.acl.capture().value.everybody,
    allowedHosts: globalConfig.allowedHosts,
  });
updateExposure();
const unbindExposure = identity.composition.subscribe(updateExposure);
const hostname = globalConfig.resolved.instance.server.host;
const port = globalConfig.resolved.instance.server.port;
const prefix = globalConfig.pathPrefix;

const app = await pathfinder({
  roots: [new URL("./api/endpoints/", import.meta.url)],
});

const allowedHosts = globalConfig.allowedHosts;
const httpServer = Deno.serve(
  { hostname, port },
  withRequestBodyLifetime((req, info: Deno.ServeHandlerInfo) => {
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
  }),
);
// Retire driver admission before closing either key custody or hub metadata.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await drivers.close();
  plugins.runtime?.suspend();
  plugins.stop();
  metadata.stop();
  hub.stop();
  unbindExposure();
  await identity.close();
  // Persistent browser streams do not have a natural completion. Process exit
  // closes them after the owned driver/storage teardown, as SIGTERM did before.
  Deno.exit();
};
Deno.addSignalListener("SIGTERM", () => {
  shutdown().catch(() => Deno.exit(1));
});
Deno.addSignalListener("SIGINT", () => {
  shutdown().catch(() => Deno.exit(1));
});
// The bound port: equal to server.port, or the OS-assigned one when that
// is 0 (test launchers read it from this line).
const boundPort = (httpServer.addr as Deno.NetAddr).port;
logger.info(
  `globnotes listening on http://${hostname}:${boundPort}${globalConfig.pathPrefix}`,
);
