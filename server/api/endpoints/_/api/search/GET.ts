// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/search — full-text search. Defaults ported from the Python
 * route: sort=score, order=desc, nested=true, folder=None, limit=None. */

import { invalid_folder_path } from "@server/api_messages.ts";
import { isValidNotePath } from "@server/helpers.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

export default function (ctx: RequestCtx) {
  const term = ctx.query.get("term") ?? "*";
  // FastAPI Literal validation: invalid sort/order values are 422 with
  // the literal_error shape.
  const sortParam = ctx.query.get("sort") ?? "score";
  const orderParam = ctx.query.get("order") ?? "desc";
  if (!["score", "title", "lastModified"].includes(sortParam)) {
    throw new HttpError(422, [{
      type: "literal_error",
      loc: ["query", "sort"],
      msg: "Input should be 'score', 'title' or 'lastModified'",
      input: sortParam,
      ctx: { expected: "'score', 'title' or 'lastModified'" },
    }]);
  }
  if (!["asc", "desc"].includes(orderParam)) {
    throw new HttpError(422, [{
      type: "literal_error",
      loc: ["query", "order"],
      msg: "Input should be 'asc' or 'desc'",
      input: orderParam,
      ctx: { expected: "'asc' or 'desc'" },
    }]);
  }
  // Python route maps lastModified → last_modified for the index.
  const sort = (sortParam === "lastModified" ? "last_modified" : sortParam) as
    | "score"
    | "title"
    | "last_modified";
  const order = orderParam as "asc" | "desc";
  const limitParam = ctx.query.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const nested = ctx.query.get("nested") !== "false";
  const folder = ctx.query.get("folder") ?? undefined;

  if (folder !== undefined) {
    try {
      isValidNotePath(folder);
    } catch {
      throw new HttpError(400, invalid_folder_path);
    }
  }
  if (!state.indexer) throw new HttpError(500, "index unavailable");
  return state.indexer.search(term, sort, order, limit, nested, folder);
}
