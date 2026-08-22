// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Root catch-all: /_/ static assets, vault files and note pages.
 *
 * Mirrors the Python server's `app.mount("/_", StaticFiles(client/dist))`
 * plus `catchall_router.get("/{path:path}")`. Registered via
 * Router.setFallback — it runs outside the middleware chain, so note
 * pages stay public while vault files authenticate explicitly
 * (Python: `require_auth(request)` inside catch_all).
 */

import * as path from "@std/path";
import { file_not_found, invalid_file_path } from "./api_messages.ts";
import { enforceAuth } from "./auth/middleware.ts";
import { FileNotFoundError, ValueError } from "./files/file_serving.ts";
import { guessType } from "./files/mimetypes.ts";
import { HttpError } from "./http_error.ts";
import type { RequestCtx } from "./router.ts";
import { state } from "./state.ts";

const MARKDOWN_EXT = ".md";
// cwd-relative, same as the Python server's "client/dist/index.html".
const DIST_DIR = path.resolve("client", "dist");
const INDEX_HTML = path.join(DIST_DIR, "index.html");

export function serveIndex(): Response {
  try {
    return new Response(Deno.readTextFileSync(INDEX_HTML), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch {
    // Client not built yet (dev checkout) — nothing honest to serve.
    throw new HttpError(404, "Not Found");
  }
}

/** Serve one built client asset (Python: the /_/ StaticFiles mount). */
function serveStatic(rel: string): Response {
  const resolved = path.resolve(DIST_DIR, rel);
  if (
    resolved !== DIST_DIR &&
    !resolved.startsWith(DIST_DIR + path.SEPARATOR)
  ) {
    throw new HttpError(404, "Not Found");
  }
  let body: Uint8Array;
  try {
    body = Deno.readFileSync(resolved);
  } catch {
    throw new HttpError(404, "Not Found");
  }
  return new Response(body as BodyInit, {
    headers: {
      "content-type": guessType(resolved) ?? "application/octet-stream",
    },
  });
}

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

export async function catchAll(ctx: RequestCtx): Promise<Response> {
  // Static client assets live under /_/ before anything vault-space.
  if (ctx.path === "/_" || ctx.path.startsWith("/_/")) {
    const rel = ctx.path === "/_" ? "" : ctx.path.slice(3);
    if (!rel || rel.includes("..")) {
      throw new HttpError(404, "Not Found");
    }
    return serveStatic(rel);
  }

  // Vault-space URL → decode (Python's {path:path} converter unquotes).
  let vaultPath: string;
  try {
    vaultPath = ctx.path.split("/").filter(Boolean)
      .map(decodeURIComponent).join("/");
  } catch {
    throw new HttpError(404, "Not Found");
  }
  const segments = vaultPath.split("/").filter(Boolean);

  // Machinery and hidden paths are never served from the vault space.
  if (segments[0] === "_" || segments.some((s) => s.startsWith("."))) {
    throw new HttpError(404, "Not Found");
  }

  const ext = path.extname(vaultPath).toLowerCase();
  if (vaultPath && ext && ext !== MARKDOWN_EXT) {
    // Looks like a file: serve it if it exists (a real 404 keeps
    // broken-image behavior honest). A note page still wins for dotted
    // titles (e.g. a note named "a/v2.1").
    try {
      await enforceAuth(ctx.req);
      const served = state.files.get(vaultPath);
      const headers: Record<string, string> = {
        "content-type": served.mediaType,
        ...served.headers,
      };
      if (served.downloadName !== null) {
        headers["content-disposition"] =
          `attachment; filename="${served.downloadName}"`;
      }
      return new Response(served.body as BodyInit, { headers });
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        if (
          !isFile(path.join(state.files.storagePath, vaultPath + MARKDOWN_EXT))
        ) {
          throw new HttpError(404, file_not_found);
        }
      } else if (e instanceof ValueError) {
        throw new HttpError(400, invalid_file_path);
      } else {
        throw e; // enforceAuth HttpErrors propagate unchanged
      }
    }
  }

  // Everything else is a note page (the client 404s unknown titles).
  return serveIndex();
}
