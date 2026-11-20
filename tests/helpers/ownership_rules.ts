// SPDX-License-Identifier: LGPL-3.0-only
import {
  type OwnershipRules,
  PROCESS_OWNERSHIP,
} from "./ownership_contract.ts";

export const RESOURCE_CORE = "shared/ownership.js";
export const RESOURCE_ENGINE = "shared/ownership-engine.js";
export const NATIVE_FINALIZER = "client/tests/e2e/native-case-finalization.mjs";

/** One explicit policy, passed to the shared root/import analyzer. */
export const RESOURCE_OWNERSHIP: OwnershipRules = {
  roots: PROCESS_OWNERSHIP.roots,
  modules: {
    ...PROCESS_OWNERSHIP.modules,
    [RESOURCE_ENGINE]: [RESOURCE_CORE],
  },
};

/** Platform-free engine: no runtime root is a public capability here.
 * Imports are checked independently against its graph dependency manifest.
 * This is another registration for the same analyzer, not a second source rule.
 */
export const RESOURCE_ENGINE_OWNERSHIP: OwnershipRules = {
  ...RESOURCE_OWNERSHIP,
  roots: Object.fromEntries([
    ...Object.keys(PROCESS_OWNERSHIP.roots),
    "document",
    "navigator",
    "fetch",
    "Worker",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
  ].map((root) => [root, { members: [] }])),
};
