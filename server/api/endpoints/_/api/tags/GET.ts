// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/tags — all indexed tags. Authenticated like the Python route. */

import { state } from "@server/state.ts";

export default function (): string[] {
  if (!state.indexer) return [];
  return state.indexer.getTags();
}
