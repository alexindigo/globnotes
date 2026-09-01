// SPDX-License-Identifier: LGPL-3.0-only

/**
 * GET /_/brand/:file* — serve the vault's brand files
 * (<vault>/.globnotes/brand/<file>) publicly: favicons, the manifest,
 * and the logo all brand surfaces that render before login. When no
 * custom site.webmanifest exists, one is generated from the brand
 * config so the manifest always reflects the branding.
 */

import * as path from "@std/path";
import { brandDirPath, generateWebManifest } from "@server/brand.ts";
import { guessType } from "@server/files/mimetypes.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

export const auth = false;

const MANIFEST_NAME = "site.webmanifest";

export default function (ctx: RequestCtx): Response {
  const rel = ctx.params.file;
  if (!rel || rel.includes("..")) {
    throw new HttpError(404, "Not Found");
  }
  const dir = brandDirPath(state.config.notesPath);
  const resolved = path.resolve(dir, rel);
  if (resolved !== dir && !resolved.startsWith(dir + path.SEPARATOR)) {
    throw new HttpError(404, "Not Found");
  }

  let body: Uint8Array;
  try {
    body = Deno.readFileSync(resolved);
  } catch {
    if (rel === MANIFEST_NAME) {
      return new Response(generateWebManifest(state.config), {
        headers: { "content-type": "application/manifest+json" },
      });
    }
    throw new HttpError(404, "Not Found");
  }
  return new Response(body as BodyInit, {
    headers: {
      "content-type": guessType(rel) ?? "application/octet-stream",
    },
  });
}
