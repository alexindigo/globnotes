// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { analyzeOwnership } from "./helpers/ownership_contract.ts";
import { assertPrivateModule } from "./helpers/credential_registration.ts";
import {
  ACCOUNT_RECORD,
  ACCOUNT_REPOSITORY,
  ADOPTION_OWNERSHIP,
  CREDENTIAL_REDUCER,
  IDENTITY_HELPER,
  OFFLINE_RECOVERY,
  PREPARATION_HELPER,
} from "./helpers/ownership_rules.ts";

for (
  const [label, module] of [
    ["direct import command", ACCOUNT_REPOSITORY],
    ["private stored decoder", ACCOUNT_RECORD],
    ["private arithmetic", CREDENTIAL_REDUCER],
    ["offline acquisition", OFFLINE_RECOVERY],
    ["test import helper", PREPARATION_HELPER],
    ["test credential binding", "tests/helpers/credential_commands.ts"],
    ["test disk reader", IDENTITY_HELPER],
  ]
) {
  Deno.test(`credential import registration: normal HTTP cannot acquire ${label}`, () => {
    assertPrivateModule(module, ADOPTION_OWNERSHIP);
  });
}
Deno.test("credential import registration: a private decoder re-export rejects only at its origin", () => {
  const sites = analyzeOwnership([
    {
      file: "server/bridge.ts",
      text: 'export {validateAccount as decode} from "record";',
      imports: { record: ACCOUNT_RECORD },
    },
    {
      file: "server/api/controller.ts",
      text: 'import {decode} from "bridge"; decode(input);',
      imports: { bridge: "server/bridge.ts" },
    },
  ], ADOPTION_OWNERSHIP);
  assertEquals(sites.map((site) => [site.file, site.capability]), [[
    "server/bridge.ts",
    `module:${ACCOUNT_RECORD}`,
  ]]);
});
Deno.test("credential import registration: ordinary redacted values and sign-in commands have no private acquisition", () => {
  assertEquals(
    analyzeOwnership([{
      file: "server/api/controller.ts",
      text:
        'import {AuthenticationError,type LoginProof} from "public"; const account=accounts.byId(id); const directory=accounts.capture(); const proof=await credentials.authenticate(login,password,code); await sessions.issue(proof);',
      imports: { public: "server/auth/account_credentials.ts" },
    }], ADOPTION_OWNERSHIP),
    [],
  );
});
