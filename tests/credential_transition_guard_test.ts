// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { analyzeOwnership } from "./helpers/ownership_contract.ts";
import { assertPrivateModule } from "./helpers/credential_registration.ts";
import {
  ACCOUNT_REPOSITORY,
  CREDENTIAL_ENGINE,
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
