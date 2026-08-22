// SPDX-License-Identifier: LGPL-3.0-only

import type { RequestCtx } from "@server/router.ts";

export default function (ctx: RequestCtx): object {
  return { id: ctx.params.id };
}
