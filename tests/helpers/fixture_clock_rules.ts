// SPDX-License-Identifier: LGPL-3.0-only
import {
  analyzeOwnership,
  type OwnershipRules,
  PROCESS_OWNERSHIP,
  type SourceModule,
} from "./ownership_contract.ts";
export const FIXTURE_CLOCK = "tests/helpers/fixture_clock.ts";
export const LIVE_TOTP = "tests/helpers/totp_live.ts";
export const FIXTURE_EPOCH = "tests/helpers/fixture_epoch.ts";
export const CLOCK_MODULE_RULES = {
  [LIVE_TOTP]: [],
  [FIXTURE_EPOCH]: ["client/tests/e2e/native-totp-fixture.mjs"],
};
/** No argument/value-flow classifier. The public reference has no live fallback;
 * legacy convenience imports and raw time roots are independently restricted. */
export function fixtureClockRules(base: OwnershipRules): OwnershipRules {
  return {
    roots: {
      ...base.roots,
      Date: {
        members: ["parse", "UTC"],
        ownedMembers: {
          now: [LIVE_TOTP, FIXTURE_EPOCH, "tests/native_totp_fixture_test.ts"],
        },
      },
      performance: { members: [] },
    },
    modules: { ...base.modules, ...CLOCK_MODULE_RULES },
  };
}
export const FIXTURE_CLOCK_OWNERSHIP = fixtureClockRules(PROCESS_OWNERSHIP);
export const fixtureClockSites = (sources: SourceModule[]) =>
  analyzeOwnership(sources, FIXTURE_CLOCK_OWNERSHIP);
