// SPDX-License-Identifier: LGPL-3.0-only

import { state } from "@server/state.ts";

/** GET /_/api/plugin-host — authoritative catalog: revision, runtime
 * status, capabilities, commands, pages and framework blocking annotations.
 * Private plugin data is never included. */
export default async function () {
  return await state.plugins!.catalog();
}
