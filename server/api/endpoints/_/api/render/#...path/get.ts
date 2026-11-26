// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";

import { note_not_found } from "@server/api_messages.ts";
import { InvalidPathError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { renderResponse } from "@server/render/response.ts";
import { state } from "@server/state.ts";
import type { ViewerAuthority } from "@server/auth/authority.ts";
import type { createInstanceAuth } from "@server/auth/middleware.ts";
import { createHttpPolicy } from "@server/auth/http_policy.ts";

export function createIdentityNoteRender(
  auth: ReturnType<typeof createInstanceAuth>,
) {
  const policy = createHttpPolicy(auth);
  return async (request: PathfinderRequest<{ path: string }>) => {
    return await policy.read(request._raw, "readVault", async ({ viewer }) => {
      return await renderNote(request, viewer);
    });
  };
}

export default function (request: PathfinderRequest<{ path: string }>) {
  return renderNote(request);
}

/** Render a note's markdown through the plugin pipeline (markdown-it +
 * sandboxed worker plugins). v1 returns the full document; streamed
 * fragments land as a follow-up without changing this contract. */
async function renderNote(
  request: PathfinderRequest<{ path: string }>,
  viewer?: ViewerAuthority,
): Promise<Response> {
  let content: string;
  try {
    content = state.notes.get(request.params.path).content ?? "";
  } catch (e) {
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
  return await renderResponse(content, request.query, viewer);
}
