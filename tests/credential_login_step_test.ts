// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { AuthenticationError } from "../server/auth/account_credentials.ts";
import { verifyPassword } from "../server/helpers.ts";
import { credentialCommandFixture } from "./helpers/credential_commands.ts";
import { ACCOUNT_A, storedState, UPDATE } from "./helpers/identity.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { receiveSession } from "./helpers/session_delivery.ts";

const MESSAGE = "Invalid authentication credentials.";
function errorShape(error: AuthenticationError, code?: string) {
  assertEquals({
    name: error.name,
    message: error.message,
    code: Reflect.get(error, "code"),
    fields: Object.keys(error),
  }, {
    name: "Error",
    message: MESSAGE,
    code,
    fields: ["code"],
  });
}

for (const code of [undefined, ""]) {
  Deno.test(`sign-in step: missing code ${JSON.stringify(code)} gives only the safe error`, () =>
    credentialCommandFixture(
      async (f) => {
        const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
        const snapshot = f.accounts.capture();
        const signing = f.sessions.signing.capture();
        const events: string[] = [];
        const issue = f.sessions.issue.bind(f.sessions);
        f.sessions.issue = (proof) => {
          events.push("issue");
          return issue(proof);
        };
        const direct = await assertRejects(
          () => f.accounts.credentials.authenticate("alice", "password", code),
          AuthenticationError,
          MESSAGE,
        );
        errorShape(direct, "authenticator_required");
        const error = await assertRejects(
          () =>
            f.sessions.login({
              username: "alice",
              password: "password",
              totp: code,
            }),
          AuthenticationError,
          MESSAGE,
        );
        errorShape(error, "authenticator_required");
        assertEquals(events, []);
        assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
        assertStrictEquals(f.accounts.capture(), snapshot);
        assertStrictEquals(f.sessions.signing.capture(), signing);
        // The step spent no code: the very next full submission succeeds.
        const issued = await f.sessions.login({
          username: "alice",
          password: "password",
          totp: await f.code(),
        });
        assertEquals(Object.keys(issued), ["principal", "body"]);
        const session = await receiveSession(issued);
        assertEquals(
          await f.sessions.validateToken(session.access_token),
          session.principal,
        );
        assertEquals(session.principal, {
          kind: "account",
          accountId: ACCOUNT_A,
          credentialRevision: 0,
          signingRevision: 1,
          expiresAt: f.now + 86_400_000,
          passwordChangeRequired: false,
        });
        assertEquals(events, ["issue"]);
        const original = JSON.parse(before), after = storedState(f.accounts);
        assertNotEquals(after.updateId, original.updateId);
        assertMatch(after.updateId!, /^[0-9a-f-]{36}$/);
        assertEquals(after, {
          ...original,
          revision: original.revision + 1,
          updateId: after.updateId,
          accounts: [{
            ...original.accounts[0],
            lastTotpStep: f.now / 30_000,
          }],
        });
      },
      {},
      { key: "key", floor: 1 },
    ));
}

Deno.test("sign-in step: unknown login, bad password and invalid codes remain generic", () =>
  credentialCommandFixture(
    async (f) => {
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      for (
        const input of [
          { username: "nobody", password: "password" },
          { username: "alice", password: "wrong" },
          { username: "alice", password: "wrong", totp: await f.code() },
          { username: "alice", password: "password", totp: "bad" },
          { username: "alice", password: "password", totp: "12345" },
          { username: "alice", password: "password", totp: 123456 },
          { username: "alice", password: "password", totp: " " },
        ]
      ) {
        const error = await assertRejects(
          () => f.sessions.login(input),
          AuthenticationError,
          MESSAGE,
        );
        errorShape(error);
        assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      }
    },
    {},
    { key: "key" },
  ));

Deno.test("sign-in step: replay stays generic and leaves the complete accepted state unchanged", () =>
  credentialCommandFixture(
    async (f) => {
      const input = {
        username: "alice",
        password: "password",
        totp: await f.code(),
      };
      const session = await receiveSession(await f.sessions.login(input));
      assertEquals(
        await f.sessions.validateToken(session.access_token),
        session.principal,
      );
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      const error = await assertRejects(
        () => f.sessions.login(input),
        AuthenticationError,
        MESSAGE,
      );
      errorShape(error);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      const step = await assertRejects(
        () => f.sessions.login({ username: "alice", password: "password" }),
        AuthenticationError,
        MESSAGE,
      );
      errorShape(step, "authenticator_required");
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    },
    {},
    { key: "key" },
  ));

Deno.test("sign-in step: password-only accounts still reach the guarded session body", () =>
  credentialCommandFixture(async (f) => {
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    for (const totp of [undefined, ""]) {
      const issued = await f.sessions.login({
        username: "alice",
        password: "password",
        totp,
      });
      assertEquals(Object.keys(issued), ["principal", "body"]);
      const session = await receiveSession(issued);
      assertEquals(
        await f.sessions.validateToken(session.access_token),
        session.principal,
      );
      assertEquals(session.principal.accountId, ACCOUNT_A);
    }
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
  }));

Deno.test("sign-in step: credential changes never expose the missing-code reason", () =>
  credentialCommandFixture(
    async (f) => {
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      const error = await assertRejects(
        () =>
          f.accounts.credentials.changeOwn(
            f.authority,
            f.request({ newPassword: "new-password" }),
          ),
        AuthenticationError,
        MESSAGE,
      );
      errorShape(error);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    },
    {},
    { key: "key" },
  ));

for (
  const boundary of [
    "abort",
    "retire",
    "account replacement",
    "credential change",
    "code progress",
  ] as const
) {
  Deno.test(`sign-in step: ${boundary} while checking the password cannot expose a stale step`, () => {
    let verify = verifyPassword;
    return credentialCommandFixture(
      async (f) => {
        const abort = new AbortController();
        const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
        const originalIdentity = f.accounts.byId(ACCOUNT_A)!;
        const events: string[] = [];
        await heldOperation({
          label: `sign-in password ${boundary}`,
          owner: () => f.sessions,
          progress: { kind: "controlled", clock: "external" },
        }, (hold) => {
          verify = async (password, hash) => {
            events.push("verify");
            await hold();
            const matched = await verifyPassword(password, hash);
            events.push(matched ? "matched" : "wrong");
            return matched;
          };
          return f.sessions.login(
            { username: "alice", password: "password" },
            abort.signal,
          );
        }, async (operation) => {
          await operation.reached();
          verify = verifyPassword;
          if (boundary === "abort") abort.abort();
          if (boundary === "retire") f.accounts.retireCredentials();
          if (boundary === "account replacement") {
            Deno.writeTextFileSync(`${f.root}/accounts.json`, before + "\n");
          }
          if (boundary === "credential change") {
            const changed = await f.accounts.credentials.changeOwn(
              f.authority,
              f.request({
                current: { password: "password", code: await f.code() },
                authenticator: { kind: "remove" },
              }),
            );
            assertEquals(changed, {
              ...originalIdentity,
              credentialRevision: 1,
              credentialUpdateId: UPDATE,
              totpEnabled: false,
            });
          }
          if (boundary === "code progress") {
            const session = await receiveSession(
              await f.sessions.login({
                username: "alice",
                password: "password",
                totp: await f.code(),
              }),
            );
            assertEquals(
              await f.sessions.validateToken(session.access_token),
              session.principal,
            );
          }
          const expected = Deno.readTextFileSync(`${f.root}/accounts.json`);
          const error = await assertRejects(
            () => operation.result(),
            AuthenticationError,
            MESSAGE,
          );
          errorShape(error);
          assertEquals(events, ["verify", "matched"]);
          assertEquals(
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            expected,
          );
          if (boundary === "abort" || boundary === "retire") {
            assertEquals(expected, before);
          }
        });
      },
      { verify: (...args) => verify(...args) },
      { key: "key" },
    );
  });
}

for (
  const thrown of [
    Object.assign(new AuthenticationError(), {
      code: "authenticator_required",
    }),
    Object.assign(new Error(MESSAGE), { code: "authenticator_required" }),
  ]
) {
  Deno.test(`sign-in step: a verifier-thrown ${thrown.constructor.name} cannot impersonate the step`, () =>
    credentialCommandFixture(async (f) => {
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      const error = await assertRejects(
        () => f.sessions.login({ username: "alice", password: "password" }),
        AuthenticationError,
        MESSAGE,
      );
      errorShape(error);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    }, {
      verify: () => {
        throw thrown;
      },
    }, { key: "key" }));
}
