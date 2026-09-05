// SPDX-License-Identifier: LGPL-3.0-only

import { HttpError, json } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export default async function (request) {
  const oldPath = request.query.get("old_path") ?? "";
  const newPath = request.query.get("new_path") ?? "";
  try {
    await state.notes.rewriteRefs(oldPath, newPath);
  } catch (e) {
    throw new HttpError(500, (e as Error).message);
  }
  return json(null);
}
