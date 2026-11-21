// SPDX-License-Identifier: LGPL-3.0-only
/** Public values only: importing the executable path does not acquire a raw
 * command constructor. Ordinary child lifetimes use spawnOwnedChild. */
export {
  childEnvironment,
  DENO,
  workerCommandDenialProbeSource,
} from "./process.ts";
export type { ChildOptions } from "./process.ts";
