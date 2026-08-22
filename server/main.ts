// SPDX-License-Identifier: LGPL-3.0-only

/**
 * globnotes server entry point (Deno/TypeScript).
 *
 * Bare Deno.serve with an owned router and a file-based endpoint loader;
 * no framework sits between the loader and the handlers.
 */

import { loadEndpoints } from "./api/loader.ts";
import { GlobalConfig } from "./config.ts";
import { getEnv } from "./helpers.ts";
import { logger } from "./logger.ts";
import { Router } from "./router.ts";

const globalConfig = new GlobalConfig();

const hostname = getEnv("GLOBNOTES_HOST", { default: "0.0.0.0" });
const port = Number(getEnv("GLOBNOTES_PORT", { castInt: true, default: 8080 }));

const router = new Router({ prefix: globalConfig.pathPrefix });
await loadEndpoints(router, new URL("./api/endpoints/", import.meta.url));

Deno.serve({ hostname, port }, (req) => router.handle(req));
logger.info(
  `globnotes listening on http://${hostname}:${port}${globalConfig.pathPrefix}`,
);
