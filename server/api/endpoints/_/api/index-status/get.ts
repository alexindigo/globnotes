// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/index-status — sync progress UI banner. Public (counts only,
 * same as the Python server). */

import { state } from "@server/state.ts";

export const auth = false;

export default function (): {
  syncing: boolean;
  initial: boolean;
  done: number;
  total: number;
} {
  return state.indexer?.indexStatus ??
    { syncing: false, initial: true, done: 0, total: 0 };
}
