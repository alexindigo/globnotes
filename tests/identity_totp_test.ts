// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { encodeBase32 } from "@std/encoding/base32";
import { AccountRepository, prepareAccount } from "../server/auth/accounts.ts";
import { decodeTotpKey, matchingTotpStep } from "../server/auth/credentials.ts";
import {
  AuthenticationError,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { identityFixture, UPDATE } from "./helpers/identity.ts";

const NOW = 1_800_000_000_000;
for (
  const bytes of [
    new TextEncoder().encode("12345678901234567890"),
    new Uint8Array(20).fill(0),
    new Uint8Array(20).fill(255),
  ]
) {
  Deno.test(`identity TOTP: exact 20-byte key ${encodeBase32(bytes)} and matched window step`, async () => {
    const secret = encodeBase32(bytes);
    assertEquals(decodeTotpKey(secret), bytes);
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
    const accounts = new AccountRepository(root);
    const alice = accounts.create(await prepareAccount("alice", "password"));
    const bob = accounts.create(await prepareAccount("bob", "password"));
    const raw = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    accounts.changeCredentials(alice.id, 0, { totpKey: raw }, UPDATE);
    accounts.changeCredentials(bob.id, 0, { totpKey: raw }, UPDATE);
    const signing = new SessionRepository(root);
    signing.initialize();
    const settings = { expirySeconds: 1000 }, options = { now: () => NOW };
    const sessions = new InstanceSessions(accounts, signing, settings, options);
    const code = await authenticatorCode(raw, NOW);
    const input = { username: "alice", password: "password", totp: code };
    const results = await Promise.allSettled([
      sessions.login(input),
      sessions.login(input),
    ]);
    assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
    assertEquals(accounts.byId(alice.id)!.credentialRevision, 1);
    const restarted = new InstanceSessions(
      new AccountRepository(root),
      new SessionRepository(root),
      settings,
      options,
    );
    await assertRejects(() => restarted.login(input), AuthenticationError);
    await restarted.login({ ...input, username: "bob" });
    const previous = await authenticatorCode(
      raw,
      NOW - 30_000,
    );
    await assertRejects(
      () => restarted.login({ ...input, totp: previous }),
      AuthenticationError,
    );
    const next = await authenticatorCode(
      raw,
      NOW + 30_000,
    );
    const accepted = await restarted.login({ ...input, totp: next });
    const winner = results.find((r) =>
      r.status === "fulfilled"
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof sessions.login>>>;
    assertEquals(
      (await restarted.validateToken(winner.value.access_token))
        .credentialRevision,
      1,
    );
    assertEquals(accepted.principal.credentialRevision, 1);
  }));

Deno.test("identity TOTP: password and code are separate and failed proof never consumes a step", () =>
  identityFixture(async (root) => {
    const accounts = new AccountRepository(root),
      person = accounts.create(await prepareAccount("alice", "password"));
    accounts.changeCredentials(person.id, 0, {
      totpKey: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    }, UPDATE);
    const signing = new SessionRepository(root);
    signing.initialize();
    const sessions = new InstanceSessions(accounts, signing, {
      expirySeconds: 1000,
    }, { now: () => NOW });
    const code = await authenticatorCode(
      "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      NOW,
    );
    for (
      const input of [
        { username: "alice", password: "password" + code },
        { username: "alice", password: "wrong", totp: code },
        { username: "alice", password: "password", totp: "bad" },
      ]
    ) await assertRejects(() => sessions.login(input), AuthenticationError);
    assertEquals(accounts.byId(person.id)?.lastTotpStep, null);
    await sessions.login({
      username: "alice",
      password: "password",
      totp: code,
    });
    assertEquals(accounts.byId(person.id)?.lastTotpStep, NOW / 30_000);
  }));
