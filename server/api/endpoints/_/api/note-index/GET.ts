// SPDX-License-Identifier: LGPL-3.0-only

import { state } from "@server/state.ts";

export default function (): string[] {
  return state.notes.getTitles();
}
