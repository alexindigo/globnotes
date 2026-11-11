// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { decodeJwt, SignJWT } from "jose";
import { AccountRepository, prepareAccount } from "../server/auth/accounts.ts";
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
  run: (s: InstanceSessions, root: string) => Promise<void>,
) {
  await identityFixture(async (root) => {
    const accounts = new AccountRepository(root);
    accounts.create(await prepareAccount("Alice", "password"));
    const signing = new SessionRepository(root);
    signing.initialize();
    await run(
      new InstanceSessions(accounts, signing, settings, { now: () => NOW }),
      root,
    );
  });
}

Deno.test("identity sessions: one account ID token survives restart without vault grants or secrets", () =>
  fixture(async (sessions, root) => {
    const result = await sessions.login({
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
        () => sessions.login(input),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    }
  }));

Deno.test("identity sessions: own credential revision revokes every old token, not another account", () =>
  fixture(async (sessions) => {
    sessions.accounts.create(
      identityAccount({
        id: ACCOUNT_B,
        login: "bob",
        passwordHash: await hashPassword("bob-password"),
      }),
    );
    const a = await sessions.login({ username: "alice", password: "password" });
    const a2 = await sessions.login({
      username: "alice",
      password: "password",
    });
    const b = await sessions.login({
      username: "bob",
      password: "bob-password",
    });
    sessions.accounts.changeCredentials(a.principal.accountId, 0, {
      passwordHash: await hashPassword("new-password"),
    }, UPDATE);
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
      () => sessions.login({ username: "alice", password: "password" }),
      AuthenticationError,
    );
    assertEquals(
      (await sessions.login({ username: "alice", password: "new-password" }))
        .principal.credentialRevision,
      1,
    );
  }));

Deno.test("identity sessions: temporary password remains explicitly restricted until credential change", () =>
  fixture(async (sessions) => {
    const person = sessions.accounts.create(
      await prepareAccount("recipient", "temporary", { temporary: true }),
    );
    const first = await sessions.login({
      username: "recipient",
      password: "temporary",
    });
    assertEquals(first.principal.passwordChangeRequired, true);
    sessions.accounts.changeCredentials(person.id, 0, {
      passwordHash: await hashPassword("own-password"),
      passwordChangeRequired: false,
    }, UPDATE);
    await assertRejects(
      () => sessions.validateToken(first.access_token),
      AuthenticationError,
    );
    const changed = await sessions.login({
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
    const result = await short.login({
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
  fixture(async (sessions) => {
    const held = Promise.withResolvers<boolean>();
    const racing = new InstanceSessions(
      sessions.accounts,
      sessions.signing,
      settings,
      { now: () => NOW, verify: () => held.promise },
    );
    const pending = racing.login({ username: "alice", password: "password" });
    sessions.accounts.changeCredentials(
      sessions.accounts.byLogin("alice")!.id,
      0,
      { passwordChangeRequired: true },
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
