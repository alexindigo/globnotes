// SPDX-License-Identifier: LGPL-3.0-only

/**
 * globnotes server entry point (Deno/TypeScript).
 *
 * Bare Deno.serve with an owned router and a file-based endpoint loader;
 * no framework sits between the loader and the handlers.
 */

import { loadEndpoints } from "./api/loader.ts";
import { LocalAuth } from "./auth/local.ts";
import { requireAuth } from "./auth/middleware.ts";
import { catchAll, serveIndex } from "./catchall.ts";
import { FileServing } from "./files/file_serving.ts";
import { FileSystemNotes } from "./notes/file_system.ts";
import { PluginManager } from "./plugins/manager.ts";
import { AuthType, GlobalConfig } from "./config.ts";
import { getEnv, rewriteIndexHtml } from "./helpers.ts";
import { logger } from "./logger.ts";
import { Router } from "./router.ts";
import { initState } from "./state.ts";
import { Fts5Indexer } from "./search/fts5.ts";

const globalConfig = new GlobalConfig();
const notes = new FileSystemNotes(globalConfig.notesPath);
const indexer = new Fts5Indexer(globalConfig.notesPath);
const fileServing = new FileServing(globalConfig.notesPath);
const plugins = new PluginManager(globalConfig.notesPath);
const auth = globalConfig.authType === AuthType.PASSWORD ||
    globalConfig.authType === AuthType.TOTP
  ? new LocalAuth(globalConfig)
  : null;
initState(globalConfig, auth, notes, indexer, fileServing, plugins);
indexer.startBackgroundSync();
await plugins.start();

// Publish the path prefix into the built client before serving it
// (Python: rewrite_index_html at import). Only when the client build
// exists — dev checkouts run the server alone.
try {
  rewriteIndexHtml("client/dist/index.html", globalConfig.pathPrefix);
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

const router = new Router({ prefix: globalConfig.pathPrefix });
router.use(requireAuth);
await loadEndpoints(router, new URL("./api/endpoints/", import.meta.url));

// UI page routes (Python's serve_index routes) — always public; the
// client handles its own auth flow.
for (const page of ["/", "/_/login", "/_/search", "/_/new"]) {
  router.add("GET", page, () => serveIndex(), { auth: false });
}

// Vault files and note pages live in the root URL space: anything not
// claimed above (API, app pages, built assets) lands here.
router.setFallback(catchAll);

Deno.serve({ hostname, port }, (req) => router.handle(req));
logger.info(
  `globnotes listening on http://${hostname}:${port}${globalConfig.pathPrefix}`,
);
