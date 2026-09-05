// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Root catch-all route: /_/ static assets, vault files and note pages.
 *
 * Mirrors the Python server's `app.mount("/_", StaticFiles(client/dist))`
 * plus `catchall_router.get("/{path:path}")`. A crossing rest at the root
 * is the lowest-priority route, so it only fires when nothing above
 * matched — the old Router.setFallback. It runs OUTSIDE the auth
 * middleware (auth = false): note pages stay public while vault files
 * authenticate explicitly inside the handler (Python:
 * `require_auth(request)`).
 */

import { HttpError } from "@pathfinder/pathfinder";

import { file_not_found, invalid_file_path } from "@server/api_messages.ts";
import { enforceAuth } from "@server/auth/middleware.ts";
import { FileNotFoundError, ValueError } from "@server/files/file_serving.ts";
import { guessType } from "@server/files/mimetypes.ts";
import { state } from "@server/state.ts";

export const auth = false;

const MARKDOWN_EXT = ".md";
// cwd-relative, same as the Python server's "client/dist/index.html".
const DIST_DIR = "client/dist";
const INDEX_HTML = DIST_DIR + "/index.html";

function serveIndex(): Response {
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
  const resolved = DIST_DIR + "/" + rel;
  if (!resolved.startsWith(DIST_DIR + "/")) {
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

export default async function (
  request,
  _context,
): Promise<Response> {
  // Static client assets live under /_/ before anything vault-space.
  const path = request.path;
  if (path === "/_" || path.startsWith("/_/")) {
    const rel = path === "/_" ? "" : path.slice(3);
    if (!rel || rel.includes("..")) {
      throw new HttpError(404, "Not Found");
    }
    return serveStatic(rel);
  }

  // Vault-space URL → decode (Python's {path:path} converter unquotes).
  let vaultPath: string;
  try {
    vaultPath = path.split("/").filter(Boolean)
      .map(decodeURIComponent).join("/");
  } catch {
    throw new HttpError(404, "Not Found");
  }
  const segments = vaultPath.split("/").filter(Boolean);

  // Machinery and hidden paths are never served from the vault space.
  if (segments[0] === "_" || segments.some((s) => s.startsWith("."))) {
    throw new HttpError(404, "Not Found");
  }

  const ext = vaultPath.includes(".")
    ? vaultPath.slice(vaultPath.lastIndexOf(".")).toLowerCase()
    : "";
  if (vaultPath && ext && ext !== MARKDOWN_EXT) {
    // Looks like a file: serve it if it exists (a real 404 keeps
    // broken-image behavior honest). A note page still wins for dotted
    // titles (e.g. a note named "a/v2.1").
    try {
      await enforceAuth(request._raw);
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
          !isFile(
            state.files.storagePath + "/" + vaultPath + MARKDOWN_EXT,
          )
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
