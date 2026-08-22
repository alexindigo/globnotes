// SPDX-License-Identifier: LGPL-3.0-only

/**
 * File-based endpoint loader (communico pattern).
 *
 * Walks an endpoints directory and registers each file as a route:
 *   <root>/<route>/<METHOD>.ts   →   <METHOD> /<route>
 *
 * Dynamic segments use bracket directories:
 *   [title]    →  :title     (single-segment param)
 *   [...title] →  :title*    (greedy rest param)
 *
 * Two roots exist by design: core endpoints (server/api/endpoints/) and
 * vault plugin endpoints (<vault>/.globnotes/plugins/<id>/endpoints/,
 * mounted at /_/api/plugins/<id>/<route>). The plugin root is wired up
 * when the Worker pool lands; the loader already supports it.
 */

import { walk } from "@std/fs/walk";
import * as path from "@std/path";
import type { Handler, Router } from "../router.ts";

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export interface LoadOptions {
  /** URL path prefix under which this root's routes are mounted. */
  mount?: string;
}

function dirToRoute(dir: string): string {
  return dir.split(path.SEPARATOR).map((seg) => {
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      return `:${seg.slice(4, -1)}*`;
    }
    if (seg.startsWith("[") && seg.endsWith("]")) {
      return `:${seg.slice(1, -1)}`;
    }
    return seg;
  }).join("/");
}

export async function loadEndpoints(
  router: Router,
  root: string | URL,
  opts: LoadOptions = {},
): Promise<void> {
  const rootPath = root instanceof URL ? path.fromFileUrl(root) : root;
  const mount = opts.mount ?? "";
  for await (
    const entry of walk(rootPath, { includeDirs: false, exts: ["ts"] })
  ) {
    const rel = path.relative(rootPath, entry.path);
    const parsed = path.parse(rel);
    const method = parsed.name.toUpperCase();
    if (!HTTP_METHODS.has(method)) continue;
    const route = mount + "/" + dirToRoute(parsed.dir);
    const mod = await import(`file://${entry.path}`);
    const handler = mod.default as Handler | undefined;
    if (typeof handler !== "function") {
      throw new Error(`Endpoint ${entry.path} has no default export`);
    }
    router.add(method, route, handler);
  }
}
