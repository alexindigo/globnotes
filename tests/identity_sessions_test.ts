// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import type { FixtureScope } from "./helpers/fixture_scope.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { decodeJwt, SignJWT } from "jose";
import { AccountRepository } from "../server/auth/accounts.ts";
import { prepareFixtureAccount } from "./helpers/identity.ts";
import {
  importFixtureAccount,
  resetFixturePassword,
} from "./helpers/account_preparation.ts";
import { withCredentialAuthority as credentialAuthorityFor } from "./helpers/credential_commands.ts";
import {
  AuthenticationError,
  GUEST,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { hashPassword } from "../server/helpers.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import {
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  UPDATE,
} from "./helpers/identity.ts";

const NOW = 1_800_000_000_000;
const settings = { expirySeconds: 30 * 86_400 };
async function fixture(
  run: (
    s: InstanceSessions,
    root: string,
    scope: FixtureScope,
  ) => Promise<void>,
) {
  await identityFixture(async (root, scope) => {
    const accounts = new AccountRepository(root);
    importFixtureAccount(
      accounts,
      await prepareFixtureAccount("Alice", "password"),
    );
    const signing = new SessionRepository(root);
    signing.initialize();
    await run(
      new InstanceSessions(accounts, signing, settings, { now: () => NOW }),
      root,
      scope,
    );
  });
}

Deno.test("identity sessions: one account ID token survives restart without vault grants or secrets", () =>
  fixture(async (sessions, root) => {
    const result = await signIn(sessions, {
      username: "ALICE",
      password: "password",
    });
    const claims = decodeJwt(result.access_token);
    assertEquals(claims.sub, sessions.accounts.byLogin("alice")!.id);
    assertEquals(claims.exp, NOW / 1000 + settings.expirySeconds);
    assertEquals(Object.keys(claims).sort(), [
      "credentialRevision",
      "exp",
      "iat",
      "signingRevision",
      "sub",
    ]);
    const restarted = new InstanceSessions(
      new AccountRepository(root),
      new SessionRepository(root),
      settings,
      { now: () => NOW },
    );
    assertEquals(
      await restarted.validateToken(result.access_token),
      result.principal,
    );
    assertEquals(await sessions.resolve(null), GUEST);
    assertEquals(Deno.statSync(`${root}/sessions.json`).mode! & 0o777, 0o600);
  }));

Deno.test("identity sessions: invalid submitted credentials are never guest and login errors are generic", () =>
  fixture(async (sessions) => {
    for (const token of ["", "garbage", "a.b.c"]) {
      await assertRejects(() => sessions.resolve(token), AuthenticationError);
    }
    for (
      const input of [
        {},
        { username: "alice", password: "wrong" },
        { username: "nobody", password: "password" },
        { username: "guest", password: "password" },
        { username: "alice", password: "password", totp: "123456" },
        { username: "alice", password: "password", vault: "other" },
        { username: "alice", password: "password", totp: 123456 },
      ]
    ) {
      await assertRejects(
        () => signIn(sessions, input),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    }
  }));

Deno.test("identity sessions: own credential revision revokes every old token, not another account", () =>
  fixture(async (sessions) => {
    importFixtureAccount(
      sessions.accounts,
      identityAccount({
        id: ACCOUNT_B,
        login: "bob",
        passwordHash: await hashPassword("bob-password"),
      }),
    );
    const a = await signIn(sessions, {
      username: "alice",
      password: "password",
    });
    const a2 = await signIn(sessions, {
      username: "alice",
      password: "password",
    });
    const b = await signIn(sessions, {
      username: "bob",
      password: "bob-password",
    });
    await resetFixturePassword(
      sessions.accounts,
      a.principal.accountId,
      "new-password",
      UPDATE,
    );
    await assertRejects(
      () => sessions.validateToken(a.access_token),
      AuthenticationError,
    );
    await assertRejects(
      () => sessions.validateToken(a2.access_token),
      AuthenticationError,
    );
    assertEquals(
      (await sessions.validateToken(b.access_token)).accountId,
      ACCOUNT_B,
    );
    await assertRejects(
      () => signIn(sessions, { username: "alice", password: "password" }),
      AuthenticationError,
    );
    assertEquals(
      (await signIn(sessions, { username: "alice", password: "new-password" }))
        .principal.credentialRevision,
      1,
    );
  }));

Deno.test("identity sessions: temporary password remains explicitly restricted until credential change", () =>
  fixture(async (sessions) => {
    const person = importFixtureAccount(
      sessions.accounts,
      await prepareFixtureAccount("recipient", "temporary", {
        temporary: true,
      }),
    );
    const first = await signIn(sessions, {
      username: "recipient",
      password: "temporary",
    });
    assertEquals(first.principal.passwordChangeRequired, true);
    await credentialAuthorityFor(
      sessions.accounts,
      person.id,
      (authority) =>
        sessions.accounts.credentials.changeOwn(authority, {
          credentialRevision: 0,
          updateId: UPDATE,
          current: { password: "temporary" },
          newPassword: "own-password",
          authenticator: { kind: "keep" },
        }),
    );
    await assertRejects(
      () => sessions.validateToken(first.access_token),
      AuthenticationError,
    );
    const changed = await signIn(sessions, {
      username: "recipient",
      password: "own-password",
    });
    assertEquals(changed.principal.passwordChangeRequired, false);
  }));

Deno.test("identity sessions: configured expiry is enforced at the boundary", () =>
  fixture(async (sessions) => {
    let now = NOW;
    const short = new InstanceSessions(sessions.accounts, sessions.signing, {
      expirySeconds: 2,
    }, { now: () => now });
    const result = await signIn(short, {
      username: "alice",
      password: "password",
    });
    now += 1999;
    assert(await short.validateToken(result.access_token));
    now++;
    await assertRejects(
      () => short.validateToken(result.access_token),
      AuthenticationError,
    );
    assertThrows(
      () => short.assertCurrent(result.principal),
      AuthenticationError,
    );
  }));

Deno.test("identity sessions: HS256, required claims, subject and signing revision are enforced", () =>
  fixture(async (sessions) => {
    const sub = sessions.accounts.byLogin("alice")!.id;
    const key = new TextEncoder().encode(sessions.signing.current().signingKey);
    for (
      const claims of [
        { sub, credentialRevision: 0, signingRevision: 1 },
        { sub, exp: NOW / 1000 + 30, signingRevision: 1 },
        {
          sub,
          exp: NOW / 1000 + 30,
          credentialRevision: 0,
          signingRevision: 9,
        },
        {
          sub: ACCOUNT_B,
          exp: NOW / 1000 + 30,
          credentialRevision: 0,
          signingRevision: 1,
        },
      ]
    ) {
      const token = await new SignJWT(claims).setProtectedHeader({
        alg: "HS256",
      }).sign(key);
      await assertRejects(
        () => sessions.validateToken(token),
        AuthenticationError,
      );
    }
    const token = await new SignJWT({
      credentialRevision: 0,
      signingRevision: 1,
    }).setSubject(sub)
      .setExpirationTime(NOW / 1000 + 30).setProtectedHeader({ alg: "HS512" })
      .sign(key);
    await assertRejects(
      () => sessions.validateToken(token),
      AuthenticationError,
    );
  }));

Deno.test("identity sessions: credential changes during password proof cannot mint an old session", () =>
  fixture(async (sessions, root, scope) => {
    const held = fixtureGate<boolean>(scope);
    const accounts = new AccountRepository(root, undefined, {
      verify: () => held.promise,
    });
    scope.onCancel(() => accounts.retireCredentials());
    const racing = new InstanceSessions(
      accounts,
      sessions.signing,
      settings,
      { now: () => NOW },
    );
    const pending = signIn(racing, { username: "alice", password: "password" });
    pending.catch(() => {});
    await resetFixturePassword(
      accounts,
      sessions.accounts.byLogin("alice")!.id,
      "new-password",
      UPDATE,
    );
    held.resolve(true);
    await assertRejects(() => pending, AuthenticationError);
  }));

Deno.test("identity signing state: absent reads are inert, corrupt state is not regenerated", () =>
  identityFixture((root) => {
    const repo = new SessionRepository(root);
    assertEquals([...Deno.readDirSync(root)], []);
    assertThrows(() => repo.current(), AuthenticationError);
    Deno.writeTextFileSync(`${root}/sessions.json`, '{"fixture-secret":true}');
    assertThrows(() => repo.initialize());
    assertThrows(() => new SessionRepository(root), IdentityStateError);
    assertEquals(
      Deno.readTextFileSync(`${root}/sessions.json`),
      '{"fixture-secret":true}',
    );
  }));

Deno.test("identity signing state: failed publication keeps missing state and cannot mint sessions", () =>
  identityFixture((root) => {
    const repo = new SessionRepository(root),
      rename = Deno.renameSync,
      link = Deno.linkSync;
    try {
      Deno.renameSync = () => {
        throw new Deno.errors.PermissionDenied("fixture");
      };
      Deno.linkSync = (from, to) => {
        Deno.renameSync(from, to);
      };
      assertThrows(() => repo.initialize(), Deno.errors.PermissionDenied);
      assertEquals(repo.capture().persistence.raw, null);
      assertThrows(() => repo.current(), AuthenticationError);
    } finally {
      Deno.renameSync = rename;
      Deno.linkSync = link;
    }
    repo.initialize();
    assert(repo.current().signingKey);
    assertThrows(() => repo.initialize(), IdentityStateError);
  }));
