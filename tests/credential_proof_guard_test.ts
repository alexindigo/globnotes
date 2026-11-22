// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { analyzeOwnership } from "./helpers/ownership_contract.ts";
import { assertPrivateModule } from "./helpers/credential_registration.ts";
import {
  ACCOUNT_REPOSITORY,
  ADOPTION_OWNERSHIP,
  CREDENTIAL_ENGINE,
  PROOF_OWNERSHIP,
} from "./helpers/ownership_rules.ts";
Deno.test("sign-in registration: the login-step pilot owns fixture use, not a private binder or repository", () => {
  const file = "tests/credential_login_step_test.ts";
  const sites = analyzeOwnership([{
    file,
    text: `
      import {credentialCommandFixture} from "fixture";
      import {storedState} from "identity";
      import {bindAccountCredentials} from "engine";
      import {AccountRepository} from "repository";
    `,
    imports: {
      fixture: "tests/helpers/credential_commands.ts",
      identity: "tests/helpers/identity.ts",
      engine: CREDENTIAL_ENGINE,
      repository: ACCOUNT_REPOSITORY,
    },
  }], ADOPTION_OWNERSHIP);
  assertEquals(sites.map((site) => [site.file, site.capability]), [
    [file, `module:${CREDENTIAL_ENGINE}`],
    [file, `module:${ACCOUNT_REPOSITORY}`],
  ]);
});
Deno.test("sign-in registration: private aggregate and repository ports reject all runtime import forms", () => {
  assertPrivateModule(CREDENTIAL_ENGINE, PROOF_OWNERSHIP);
  assertPrivateModule(ACCOUNT_REPOSITORY, PROOF_OWNERSHIP);
});
Deno.test("sign-in registration: safe errors, erased proof types and normal commands stay public", () => {
  assertEquals(
    analyzeOwnership([{
      file: "server/api/controller.ts",
      text:
        'import {AuthenticationError,type LoginProof} from "public"; const proof=await credentials.authenticate(login,password,code); await sessions.issue(proof);',
      imports: { public: "server/auth/account_credentials.ts" },
    }], PROOF_OWNERSHIP),
    [],
  );
});
Deno.test("sign-in registration: a binder bridge rejects at the producer only", () => {
  const sites = analyzeOwnership([
    {
      file: "server/bridge.ts",
      text: 'export {bindAccountCredentials as bind} from "private";',
      imports: { private: CREDENTIAL_ENGINE },
    },
    {
      file: "server/api/controller.ts",
      text: 'import {bind} from "bridge"; bind(input);',
      imports: { bridge: "server/bridge.ts" },
    },
  ], PROOF_OWNERSHIP);
  assertEquals(sites.map((site) => [site.file, site.capability]), [[
    "server/bridge.ts",
    `module:${CREDENTIAL_ENGINE}`,
  ]]);
});
