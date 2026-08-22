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
import { FileSystemNotes } from "./notes/file_system.ts";
import { AuthType, GlobalConfig } from "./config.ts";
import { getEnv } from "./helpers.ts";
import { logger } from "./logger.ts";
import { Router } from "./router.ts";
import { initState } from "./state.ts";
import { Fts5Indexer } from "./search/fts5.ts";

const globalConfig = new GlobalConfig();
const notes = new FileSystemNotes(globalConfig.notesPath);
const indexer = new Fts5Indexer(globalConfig.notesPath);
const auth = globalConfig.authType === AuthType.PASSWORD ||
    globalConfig.authType === AuthType.TOTP
  ? new LocalAuth(globalConfig)
  : null;
initState(globalConfig, auth, notes, indexer);
indexer.startBackgroundSync();

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

Deno.serve({ hostname, port }, (req) => router.handle(req));
logger.info(
  `globnotes listening on http://${hostname}:${port}${globalConfig.pathPrefix}`,
);
