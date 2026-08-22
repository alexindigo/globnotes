// SPDX-License-Identifier: LGPL-3.0-only

/**
 * globnotes server entry point (Deno/TypeScript).
 *
 * Bare Deno.serve with an owned router and a file-based endpoint loader;
 * no framework sits between the loader and the handlers.
 */

import { loadEndpoints } from "./api/loader.ts";
import { Router } from "./router.ts";

const hostname = Deno.env.get("GLOBNOTES_HOST") ?? "0.0.0.0";
const port = Number(Deno.env.get("GLOBNOTES_PORT") ?? "8080");
const pathPrefix = Deno.env.get("GLOBNOTES_PATH_PREFIX") ?? "";
if (pathPrefix && (!pathPrefix.startsWith("/") || pathPrefix.endsWith("/"))) {
  console.error(
    "Invalid value for GLOBNOTES_PATH_PREFIX. Must start with '/' and not end with '/'.",
  );
  Deno.exit(1);
}

const router = new Router({ prefix: pathPrefix });
await loadEndpoints(router, new URL("./api/endpoints/", import.meta.url));

Deno.serve({ hostname, port }, (req) => router.handle(req));
console.log(`globnotes (deno) listening on http://${hostname}:${port}`);
