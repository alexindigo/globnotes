// SPDX-License-Identifier: LGPL-3.0-only

import { PluginManager } from "../../server/plugins/manager.ts";
import { testEnvironment } from "./environment.ts";

/** Test-owned manager construction, like the clean child launcher in process.ts.
 * No test falls back to the shared process environment when it omits options. */
export function createPluginManager(
  ...[vault, rpc, workers, state, options]: ConstructorParameters<
    typeof PluginManager
  >
): PluginManager {
  return new PluginManager(vault, rpc, workers, state, {
    ...options,
    env: options?.env ?? testEnvironment(),
  });
}
