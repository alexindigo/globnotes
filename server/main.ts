// SPDX-License-Identifier: LGPL-3.0-only

/**
 * globnotes server entry point (Deno/TypeScript).
 *
 * @pathfinder/pathfinder owns routing: filesystem-routed endpoints
 * (server/api/endpoints/), an app-wide auth middleware (_/00-auth.ts),
 * a root crossing-rest catch-all for vault files and note pages, and a
 * package-owned /_status ops face. A thin wrapper re-homes the configured
 * path prefix onto each Request before the app sees it.
 */

import { pathfinder } from "@pathfinder/pathfinder";
import { LocalAuth } from "./auth/local.ts";
import { FileServing } from "./files/file_serving.ts";
import { FileSystemNotes } from "./notes/file_system.ts";
import { PluginManager } from "./plugins/manager.ts";
import { makePluginRpc } from "./plugins/rpc.ts";
import { AuthType, GlobalConfig } from "./config.ts";
import { getEnv, rewriteIndexHtml } from "./helpers.ts";
import { logger } from "./logger.ts";
import { initState } from "./state.ts";
import { Fts5Indexer } from "./search/fts5.ts";

const globalConfig = new GlobalConfig();
const notes = new FileSystemNotes(globalConfig.notesPath);
const indexer = new Fts5Indexer(globalConfig.notesPath);
notes.setIndexer(indexer);
indexer.bindNotes(notes);
const fileServing = new FileServing(globalConfig.notesPath);
const plugins = new PluginManager(
  globalConfig.notesPath,
  makePluginRpc({
    notes,
    indexer,
    files: fileServing,
    basePath: globalConfig.pathPrefix,
  }),
);
indexer.bindPlugins(plugins);
const auth = globalConfig.authType === AuthType.PASSWORD ||
    globalConfig.authType === AuthType.TOTP
  ? new LocalAuth(globalConfig)
  : null;
initState(globalConfig, auth, notes, indexer, fileServing, plugins);
indexer.startBackgroundSync();
// Plugins start lazily on the first render call (manager.ensureStarted).

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
const globDir = `${globalConfig.notesPath}/.globnotes`;
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

if (globalConfig.setupRequired) {
  logger.info("First-run setup required. Open the web UI to complete setup.");
} else if (globalConfig.authType === AuthType.NONE) {
  logger.warning(
    "globnotes is running with NO authentication. Anyone who can " +
      "reach this server can read and modify notes.",
  );
}
if (auth?.isTotpEnabled) {
  await auth.displayTotpEnrolment();
}

const hostname = getEnv("GLOBNOTES_HOST", { default: "0.0.0.0" });
const port = Number(getEnv("GLOBNOTES_PORT", { castInt: true, default: 8080 }));
const prefix = globalConfig.pathPrefix;

const app = await pathfinder({
  roots: [new URL("./api/endpoints/", import.meta.url)],
});

Deno.serve({ hostname, port }, (req, info) => {
  if (!prefix) return app(req, info);
  const url = new URL(req.url);
  if (!url.pathname.startsWith(prefix)) {
    return Response.json({ detail: "Not Found" }, { status: 404 });
  }
  const stripped = url.pathname.slice(prefix.length) || "/";
  return app(new Request(new URL(stripped, url.origin), req), info);
});
logger.info(
  `globnotes listening on http://${hostname}:${port}${globalConfig.pathPrefix}`,
);
