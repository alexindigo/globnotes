// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";

/** GET /_/api/index-status - vault reader sync progress. */

import { state } from "@server/state.ts";

export default function (): {
  syncing: boolean;
  initial: boolean;
  done: number;
  total: number;
  failed?: number;
} {
  return state.indexer?.indexStatus ??
    { syncing: false, initial: true, done: 0, total: 0, failed: 0 };
}
