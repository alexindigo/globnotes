// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { analyzeOwnership } from "./helpers/ownership_contract.ts";
import { assertPrivateModule } from "./helpers/credential_registration.ts";
import {
  CREDENTIAL_ENGINE,
  OFFLINE_RECOVERY,
  PREPARATION_HELPER,
  PREPARATION_OWNERSHIP,
} from "./helpers/ownership_rules.ts";
Deno.test("account preparation registration: HTTP cannot import offline authority, private preparation or its test helper", () => {
  for (
    const module of [OFFLINE_RECOVERY, CREDENTIAL_ENGINE, PREPARATION_HELPER]
  ) assertPrivateModule(module, PREPARATION_OWNERSHIP);
});
Deno.test("account preparation registration: offline re-export rejects at its origin, not its consumer", () => {
  const sites = analyzeOwnership([
    {
      file: "server/bridge.ts",
      text: 'export {acquireOfflineRecovery as recover} from "private";',
      imports: { private: OFFLINE_RECOVERY },
    },
    {
      file: "server/api/controller.ts",
      text: 'import {recover} from "bridge"; recover(root);',
      imports: { bridge: "server/bridge.ts" },
    },
  ], PREPARATION_OWNERSHIP);
  assertEquals(sites.map((site) => [site.file, site.capability]), [[
    "server/bridge.ts",
    `module:${OFFLINE_RECOVERY}`,
  ]]);
});
Deno.test("account preparation registration: issued preparation commands do not confer a private binder", () => {
  assertEquals(
    analyzeOwnership([{
      file: "server/api/controller.ts",
      text:
        "const value=await credentials.prepareInitialAccount(authority,request); credentials.publishPreparedAccount(value.prepared);",
    }], PREPARATION_OWNERSHIP),
    [],
  );
});
