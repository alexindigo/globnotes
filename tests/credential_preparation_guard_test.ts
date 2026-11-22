// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { analyzeOwnership } from "./helpers/ownership_contract.ts";
import { assertPrivateModule } from "./helpers/credential_registration.ts";
import {
  ACCOUNT_PARTICIPATION,
  AUTHORITY_READ,
  CREDENTIAL_ENGINE,
  OFFLINE_RECOVERY,
  PARTICIPANT_COMPLETION,
  PREPARATION_HELPER,
  PREPARATION_OWNERSHIP,
  PUBLICATION_VALIDATION,
} from "./helpers/ownership_rules.ts";
Deno.test("account preparation registration: HTTP cannot import offline authority, private preparation or its test helper", () => {
  for (
    const module of [OFFLINE_RECOVERY, CREDENTIAL_ENGINE, PREPARATION_HELPER]
  ) assertPrivateModule(module, PREPARATION_OWNERSHIP);
});
Deno.test("account participation registration: completion and ACL provenance cannot be acquired by workflows", () => {
  for (
    const module of [
      ACCOUNT_PARTICIPATION,
      PARTICIPANT_COMPLETION,
      AUTHORITY_READ,
      PUBLICATION_VALIDATION,
      "server/auth/internal/authority_context.ts",
    ]
  ) {
    assertPrivateModule(module, PREPARATION_OWNERSHIP);
  }
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
Deno.test("bootstrap registration: erased initial proof and issued commands confer no completion binder", () => {
  assertEquals(
    analyzeOwnership([{
      file: "server/api/controller.ts",
      text:
        'import type {InitialAccountProof} from "public"; const proof=credentials.initialAccountProof(account,acl); await sessions.issue(proof);',
      imports: { public: "server/auth/account_credentials.ts" },
    }], PREPARATION_OWNERSHIP),
    [],
  );
  for (
    const module of [
      ACCOUNT_PARTICIPATION,
      PARTICIPANT_COMPLETION,
      CREDENTIAL_ENGINE,
    ]
  ) {
    assertPrivateModule(module, PREPARATION_OWNERSHIP);
  }
});
