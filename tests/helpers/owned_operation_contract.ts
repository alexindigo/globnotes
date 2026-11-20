// SPDX-License-Identifier: LGPL-3.0-only
import {
  analyzeOwnership,
  type OwnershipRules,
  PROCESS_OWNERSHIP,
  type SourceModule,
} from "./ownership_contract.ts";

const deferredOwners = [
  "tests/helpers/owned_operation.ts",
  "tests/helpers/wait.ts",
  "tests/helpers/product_settlement.ts",
  "tests/helpers/process_records.ts",
  "tests/helpers/fixture_coordination.ts",
  "tests/owned_operation_test.ts",
  "tests/fixture_scope_test.ts",
  "tests/owned_record_channel_test.ts",
  "tests/owned_child_test.ts",
];
const timerOwners = ["tests/helpers/wait.ts", "tests/helpers/owned_child.ts"];
const constructorOwners = [
  "tests/helpers/fixture_scope_engine.ts",
  "tests/helpers/fixture_coordination.ts",
  "tests/helpers/process_records.ts",
  "tests/helpers/record_publication.ts",
  "tests/ownership_scope_test.ts",
  "tests/owned_child_test.ts",
  "tests/owned_record_channel_test.ts",
];
/** Raw coordination is a root/module acquisition, not an inferred alias call.
 * Ordinary Promise results stay public. Constructors/namespace captures reject;
 * low-level engines use their exact declared direct members. */
export function coordinationRules(base: OwnershipRules): OwnershipRules {
  return {
    roots: {
      ...base.roots,
      Promise: {
        ownedReferences: base.roots.Promise
          ? base.roots.Promise.ownedReferences ?? []
          : constructorOwners,
        members: ["resolve", "reject", "all", "allSettled"].filter((member) =>
          !base.roots.Promise || base.roots.Promise.members.includes(member)
        ),
        ownedMembers: {
          withResolvers: base.roots.Promise
            ? base.roots.Promise.ownedMembers?.withResolvers ??
              (base.roots.Promise.members.includes("withResolvers")
                ? deferredOwners
                : [])
            : deferredOwners,
          race: [
            "tests/helpers/wait.ts",
            "tests/helpers/product_settlement.ts",
            "tests/helpers/process_records.ts",
          ],
          any: [],
        },
      },
      setTimeout: { members: [] },
      setInterval: { members: [] },
      setImmediate: { members: [] },
      ...Object.fromEntries(
        ["globalThis", "self", "window", "global"].map((root) => [root, {
          ...base.roots[root],
          ownedMembers: {
            ...base.roots[root]?.ownedMembers,
            setTimeout: timerOwners,
            setInterval: [],
            setImmediate: [],
            Promise: [],
          },
        }]),
      ),
    },
    modules: {
      ...base.modules,
      "node:timers": ["tests/helpers/product_settlement.ts"],
      "node:timers/promises": [],
    },
  };
}
export const OPERATION_OWNERSHIP = coordinationRules(PROCESS_OWNERSHIP);
export const OPERATION_INVENTORY_BASE =
  "29d2f9d609ce40979dd01b58df7c2d347cd6f8b1";
export const operationCoordinationSites = (sources: SourceModule[]) =>
  analyzeOwnership(sources, OPERATION_OWNERSHIP);
