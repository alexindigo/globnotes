// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/setup — first-run setup status. Public by design. */

import { state } from "@server/state.ts";

export const auth = false;

export default function (): { setupRequired: boolean } {
  return { setupRequired: state.config.setupRequired };
}
