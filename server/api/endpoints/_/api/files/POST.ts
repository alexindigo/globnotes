// SPDX-License-Identifier: LGPL-3.0-only

import { invalid_file_name } from "@server/api_messages.ts";
import { ValueError } from "@server/files/file_serving.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

/** Upload a file into the given directory (relative to the notes
 * root), creating the directory if needed. */
export default async function (ctx: RequestCtx) {
  const form = await ctx.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(422, "file field is required");
  }
  const directory = (form.get("directory") as string | null) ?? "";
  const body = new Uint8Array(await file.arrayBuffer());
  try {
    return state.files.create(directory, file.name, body);
  } catch (e) {
    if (e instanceof ValueError) {
      throw new HttpError(400, invalid_file_name);
    }
    throw e;
  }
}
