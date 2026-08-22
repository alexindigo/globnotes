// SPDX-License-Identifier: LGPL-3.0-only

import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

export default async function (ctx: RequestCtx) {
  const oldPath = ctx.query.get("old_path") ?? "";
  const newPath = ctx.query.get("new_path") ?? "";
  try {
    await state.notes.rewriteRefs(oldPath, newPath);
  } catch (e) {
    throw new HttpError(500, (e as Error).message);
  }
  return null;
}
