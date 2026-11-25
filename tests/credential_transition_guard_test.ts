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

const binderImport =
  'import { bindCredentialAuthority as bind } from "private";';

for (
  const use of [
    "export const exposed = bind;",
    "const alias = bind; export { alias };",
    "const exposed = { bind };",
    "consume(bind);",
    "function expose() { return bind; }",
    "let alias; alias = bind;",
    "const exposed = [bind];",
    "const exposed = { ...bind };",
    "bind.call(null);",
    "const expose = () => bind;",
    "(0, bind)();",
    "bind(bind);",
  ]
) {
  Deno.test(`private binder is call-only: ${use}`, () => {
    assertEquals(
      analyzeOwnership([{
        file: "server/auth/account.ts",
        text: `${binderImport}\n${use}`,
        imports: { private: CREDENTIAL_ENGINE },
      }], ADOPTION_OWNERSHIP),
      [{
        file: "server/auth/account.ts",
        capability: `module:${CREDENTIAL_ENGINE}`,
        line: 2,
        source: "bind",
        context: use,
      }],
    );
  });
}
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

Deno.test("own-account registration: private bindings and module edges cannot be exported", () => {
  for (
    const text of [
      'export {bindCredentialAuthority} from "private";',
      'export {bindCredentialAuthority as bind} from "private";',
      'export * from "private";',
      'export * as privateEngine from "private";',
      'import {bindCredentialAuthority as bind} from "private"; export {bind};',
      'import {bindCredentialAuthority as bind} from "private"; export default bind;',
      'import {bindCredentialAuthority as bind} from "private"; export default (bind);',
      'import {bindCredentialAuthority as bind} from "private"; export default bind as typeof bind;',
      'import {bindCredentialAuthority as bind} from "private"; export default bind satisfies typeof bind;',
      'import {bindCredentialAuthority as bind} from "private"; export default <typeof bind>bind;',
      'import {bindCredentialAuthority as bind} from "private"; export default bind!;',
      'import {bindCredentialAuthority as bind} from "private"; export default bind<string>;',
      'import {bindCredentialAuthority as bind} from "private"; export default ((<typeof bind>bind!) as typeof bind) satisfies typeof bind;',
      'import {bindCredentialAuthority as bind} from "private"; export = (bind!);',
      'export import engine = require("private");',
      'export const exposed = import("private");',
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
    }], text);
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

Deno.test("private binder references are resolved by symbol, not spelling", () => {
  assertEquals(
    analyzeOwnership([{
      file: "server/auth/account.ts",
      text: `bind();
        ${binderImport}
        export const result = bind();
        export type Binder = typeof bind;
        export type { bind as PrivateType };
        ((<typeof bind>bind!) as typeof bind satisfies typeof bind)();
        (bind<string>)();
        export default (0 as number);
        export function shadow(bind: unknown) { return { bind }; }
        consume({ bind: false }.bind);`,
      imports: { private: CREDENTIAL_ENGINE },
    }], ADOPTION_OWNERSHIP),
    [],
  );
});

Deno.test("call-only registration covers other private bindings and import aliases", () => {
  const uses = [
    ['import other from "private";', "const alias = other;", "other"],
    ['import * as engine from "private";', "engine.bind();", "engine"],
    ['import engine = require("private");', "consume(engine);", "engine"],
    [
      'import { bindAccountCredentials as other } from "private";',
      "export { other as exposed };",
      "other",
    ],
  ];
  for (const [binding, use, source] of uses) {
    assertEquals(
      analyzeOwnership([{
        file: "server/auth/account.ts",
        text: `${binding}\n${use}`,
        imports: { private: CREDENTIAL_ENGINE },
      }], ADOPTION_OWNERSHIP),
      [{
        file: "server/auth/account.ts",
        capability: `module:${CREDENTIAL_ENGINE}`,
        line: 2,
        source,
        context: use,
      }],
    );
  }
});
