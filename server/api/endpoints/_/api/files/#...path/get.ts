// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";
import { createIdentityFileGet } from "@server/files/response.ts";
export { createIdentityFileGet };
import { activeAuth } from "@server/auth/middleware.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

/** Download a file from anywhere in the notes tree (direct API access —
 * raw markdown for agents; note-relative vault files are served by the
 * root catch-all). */
export default function (
  request: PathfinderRequest<{ path: string }>,
): Promise<Response> {
  return createIdentityFileGet(activeAuth(), state.files)(
    request._raw,
    request.params.path,
  );
}
