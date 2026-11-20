// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeBase32 } from "@std/encoding/base32";
import { AccountRepository, prepareAccount } from "../server/auth/accounts.ts";
import {
  matchingTotpStep,
  totpSecretFromRawKey,
} from "../server/auth/credentials.ts";
import {
  AuthenticationError,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { identityFixture, UPDATE } from "./helpers/identity.ts";

const NOW = 1_800_000_000_000;
for (
  const raw of [
    "A",
    "ABCDE",
    "12345678901234567890",
    "A".repeat(65),
    "caf\u00e9",
    "\ud83d\udd10",
  ]
) {
  Deno.test(`identity TOTP: exact ${new TextEncoder().encode(raw).length}-byte key and matched window step`, async () => {
    const secret = encodeBase32(new TextEncoder().encode(raw)).replace(
      /=+$/,
      "",
    );
    assertEquals(totpSecretFromRawKey(raw), secret);
    for (const delta of [-2, -1, 0, 1, 2]) {
      const code = await authenticatorCode(secret, NOW + delta * 30_000);
      assertEquals(
        matchingTotpStep(code, secret, NOW),
        Math.abs(delta) <= 1 ? NOW / 30_000 + delta : null,
      );
    }
  });
}

Deno.test("identity TOTP: accepted-step replay survives concurrent logins and restart, per account", () =>
  identityFixture(async (root) => {
    const accounts = new AccountRepository(root, undefined, { now: () => NOW });
    const alice = accounts.create(await prepareAccount("alice", "password"));
    const bob = accounts.create(await prepareAccount("bob", "password"));
    const raw = "short";
    accounts.changeCredentials(alice.id, 0, { totpKey: raw }, UPDATE);
    accounts.changeCredentials(bob.id, 0, { totpKey: raw }, UPDATE);
    const signing = new SessionRepository(root);
    signing.initialize();
    const settings = { expirySeconds: 1000 }, options = { now: () => NOW };
    const sessions = new InstanceSessions(accounts, signing, settings, options);
    const code = await authenticatorCode(totpSecretFromRawKey(raw), NOW);
    const input = { username: "alice", password: "password", totp: code };
    const results = await Promise.allSettled([
      signIn(sessions, input),
      signIn(sessions, input),
    ]);
    assertEquals(results.map((result) => result.status).sort(), [
      "fulfilled",
      "rejected",
    ]);
    const [winner, loser] = results[0].status === "fulfilled"
      ? results
      : [results[1], results[0]];
    assert(winner.status === "fulfilled");
    assert(loser.status === "rejected");
    assert(loser.reason instanceof AuthenticationError);
    assertEquals(loser.reason.message, "Invalid authentication credentials.");
    assertEquals(accounts.byId(alice.id)!.credentialRevision, 1);
    const restarted = new InstanceSessions(
      new AccountRepository(root, undefined, { now: () => NOW }),
      new SessionRepository(root),
      settings,
      options,
    );
    await assertRejects(() => signIn(restarted, input), AuthenticationError);
    await signIn(restarted, { ...input, username: "bob" });
    const previous = await authenticatorCode(
      totpSecretFromRawKey(raw),
      NOW - 30_000,
    );
    await assertRejects(
      () => signIn(restarted, { ...input, totp: previous }),
      AuthenticationError,
    );
    const next = await authenticatorCode(
      totpSecretFromRawKey(raw),
      NOW + 30_000,
    );
    const accepted = await signIn(restarted, { ...input, totp: next });
    assertEquals(
      (await restarted.validateToken(winner.value.access_token))
        .credentialRevision,
      1,
    );
    assertEquals(accepted.principal.credentialRevision, 1);
  }));

Deno.test("identity TOTP: password and code are separate and failed proof never consumes a step", () =>
  identityFixture(async (root) => {
    const accounts = new AccountRepository(root, undefined, { now: () => NOW }),
      person = accounts.create(await prepareAccount("alice", "password"));
    accounts.changeCredentials(person.id, 0, { totpKey: "ABCDE" }, UPDATE);
    const signing = new SessionRepository(root);
    signing.initialize();
    const sessions = new InstanceSessions(accounts, signing, {
      expirySeconds: 1000,
    }, { now: () => NOW });
    const code = await authenticatorCode(totpSecretFromRawKey("ABCDE"), NOW);
    for (
      const input of [
        { username: "alice", password: "password" + code },
        { username: "alice", password: "wrong", totp: code },
        { username: "alice", password: "password", totp: "bad" },
      ]
    ) await assertRejects(() => signIn(sessions, input), AuthenticationError);
    assertEquals(accounts.byId(person.id)?.lastTotpStep, null);
    await signIn(sessions, {
      username: "alice",
      password: "password",
      totp: code,
    });
    assertEquals(accounts.byId(person.id)?.lastTotpStep, NOW / 30_000);
  }));
