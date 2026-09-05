// SPDX-License-Identifier: LGPL-3.0-only

import { file_not_found, invalid_file_path } from "@server/api_messages.ts";
import { FileNotFoundError, ValueError } from "@server/files/file_serving.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

/** Download a file from anywhere in the notes tree (direct API access —
 * raw markdown for agents; note-relative vault files are served by the
 * root catch-all). */
export default function (request): Response {
  try {
    const served = state.files.get(request.params.path);
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
    if (e instanceof ValueError) {
      throw new HttpError(400, invalid_file_path);
    }
    if (e instanceof FileNotFoundError) {
      throw new HttpError(404, file_not_found);
    }
    throw e;
  }
}
