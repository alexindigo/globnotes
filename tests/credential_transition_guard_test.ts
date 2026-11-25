// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { analyzeOwnership } from "./helpers/ownership_contract.ts";
import { assertPrivateModule } from "./helpers/credential_registration.ts";
import {
  ACCOUNT_RECORD,
  ACCOUNT_REPOSITORY,
  ADOPTION_OWNERSHIP,
  CREDENTIAL_ENGINE,
  CREDENTIAL_REDUCER,
  OFFLINE_RECOVERY,
  PREPARATION_HELPER,
  PROOF_OWNERSHIP,
  SECRET_CODEC,
} from "./helpers/ownership_rules.ts";
Deno.test("credential command registration: private binders, raw ports and codec require exact module owners", () => {
  for (
    const module of [
      CREDENTIAL_ENGINE,
      ACCOUNT_REPOSITORY,
      SECRET_CODEC,
      "tests/helpers/credential_commands.ts",
    ]
  ) {
    assertPrivateModule(module, PROOF_OWNERSHIP);
  }
});
Deno.test("own-account registration: only the exact workflow binds commands and it gains no raw record, verifier or recovery port", () => {
  assertEquals(
    analyzeOwnership([{
      file: "server/auth/account.ts",
      text: 'import {bindCredentialAuthority} from "private";',
      imports: { private: CREDENTIAL_ENGINE },
    }], ADOPTION_OWNERSHIP),
    [],
  );
  for (
    const module of [
      ACCOUNT_REPOSITORY,
      SECRET_CODEC,
      ACCOUNT_RECORD,
      CREDENTIAL_REDUCER,
      OFFLINE_RECOVERY,
      PREPARATION_HELPER,
      "tests/helpers/credential_commands.ts",
    ]
  ) {
    const sites = analyzeOwnership([{
      file: "server/auth/account.ts",
      text: 'export * from "private";',
      imports: { private: module },
    }], ADOPTION_OWNERSHIP);
    assertEquals(sites.map(({ file, capability }) => ({ file, capability })), [{
      file: "server/auth/account.ts",
      capability: `module:${module}`,
    }]);
  }
  const sites = analyzeOwnership([{
    file: "server/auth/account-copy.ts",
    text: 'import {bindCredentialAuthority} from "private";',
    imports: { private: CREDENTIAL_ENGINE },
  }], ADOPTION_OWNERSHIP);
  assertEquals(sites.map(({ file, capability }) => ({ file, capability })), [{
    file: "server/auth/account-copy.ts",
    capability: `module:${CREDENTIAL_ENGINE}`,
  }]);
});
Deno.test("credential command registration: narrow commands and candidate presentation grant no binder", () => {
  assertEquals(
    analyzeOwnership([{
      file: "server/api/controller.ts",
      text:
        "await credentials.beginEnrollment(authority); await credentials.changeOwn(authority,request,signal);",
    }], PROOF_OWNERSHIP),
    [],
  );
});
Deno.test("credential command registration: trusted test binding cannot be re-exported by a workflow", () => {
  const sites = analyzeOwnership([{
    file: "server/api/bridge.ts",
    text: 'export {bindCredentialAuthority as bind} from "private";',
    imports: { private: CREDENTIAL_ENGINE },
  }], PROOF_OWNERSHIP);
  assertEquals(sites.map((site) => site.capability), [
    `module:${CREDENTIAL_ENGINE}`,
  ]);
});

Deno.test("own-account registration: the binder import grants use, not re-export", () => {
  for (
    const text of [
      'export {bindCredentialAuthority} from "private";',
      'export {bindCredentialAuthority as bind} from "private";',
      'export * from "private";',
      'export * as privateEngine from "private";',
      'import {bindCredentialAuthority as bind} from "private"; export {bind};',
      'import {bindCredentialAuthority as bind} from "private"; export default bind;',
    ]
  ) {
    const sites = analyzeOwnership([{
      file: "server/auth/account.ts",
      text,
      imports: { private: CREDENTIAL_ENGINE },
    }], ADOPTION_OWNERSHIP);
    assertEquals(sites.map(({ file, capability }) => ({ file, capability })), [{
      file: "server/auth/account.ts",
      capability: `module:${CREDENTIAL_ENGINE}`,
    }]);
  }
  assertEquals(
    analyzeOwnership([{
      file: "server/auth/account.ts",
      text: 'export type {CredentialAuthority} from "private";',
      imports: { private: CREDENTIAL_ENGINE },
    }], ADOPTION_OWNERSHIP),
    [],
  );
});
