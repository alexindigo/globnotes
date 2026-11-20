// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { encodeBase32 } from "@std/encoding/base32";
import { AccountRepository } from "../server/auth/accounts.ts";
import {
  AuthenticationError,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { bootServer } from "./helpers/boot.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import { authenticatorCode, settledTotpNow } from "./helpers/totp.ts";
import {
  identityAccount,
  identityFixture,
  UPDATE,
} from "./helpers/identity.ts";

const NOW = 1_800_000_000_000;
const base32 = (bytes: Uint8Array) => encodeBase32(bytes).replace(/=+$/, "");
const utf8 = (text: string) => new TextEncoder().encode(text);

Deno.test("stored TOTP upgrade: effective legacy aliases retain the persisted replay floor", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    const account = accounts.importAccount(identityAccount({
      totpKey: "key",
      lastTotpStep: 100,
    }));
    accounts.changeCredentials(account.id, 0, { totpKey: "key\0" }, UPDATE);
    assertEquals(accounts.byId(account.id)?.lastTotpStep, 100);
    assertEquals(
      new AccountRepository(root).byId(account.id)?.lastTotpStep,
      100,
    );
  }));

Deno.test("stored TOTP upgrade: alias classes preserve floor, block-boundary and genuinely different keys reset it", () =>
  identityFixture(async (root) => {
    const long = "x".repeat(65);
    const reduced = base32(
      new Uint8Array(await crypto.subtle.digest("SHA-1", utf8(long))),
    );
    const cases = [
      { left: "\ud800", right: "\ufffd", same: true },
      {
        left: "1234567890123456789",
        right: base32(utf8("1234567890123456789\0")),
        marked: true,
        same: true,
      },
      { left: long, right: reduced, marked: true, same: true },
      { left: "x".repeat(63), right: "x".repeat(63) + "\0", same: true },
      { left: "x".repeat(64), right: "x".repeat(64) + "\0", same: false },
      { left: long, right: long + "\0", same: false },
      { left: "key", right: "kez", same: false },
    ];
    for (const [index, control] of cases.entries()) {
      const directory = `${root}/case-${index}`;
      const accounts = new AccountRepository(directory);
      const account = accounts.importAccount(
        identityAccount({ totpKey: control.left, lastTotpStep: 100 }),
      );
      accounts.changeCredentials(account.id, 0, {
        totpKey: control.right,
        ...(control.marked ? { totpKeyEncoding: "base32" as const } : {}),
      }, UPDATE);
      const reopened = new AccountRepository(directory);
      assertEquals(
        reopened.byId(account.id)?.lastTotpStep,
        control.same ? 100 : null,
      );
      if (control.same) {
        assertThrows(() => reopened.consumeTotp(account.id, 1, 100));
      }
      reopened.consumeTotp(account.id, 1, 101);
      assertEquals(
        new AccountRepository(directory).byId(account.id)?.lastTotpStep,
        101,
      );
    }
  }));

for (
  const stored of [
    { key: "key" },
    { key: "key\0", encoding: null },
    { key: "caf\u00e9" },
    { key: "\ud800" },
    { key: "A".repeat(32) },
    { key: "A".repeat(32), encoding: "base32" as const },
    { key: "x".repeat(65) },
  ]
) {
  Deno.test(`stored TOTP upgrade: account login/restart preserves ${JSON.stringify(stored)}`, () =>
    identityFixture(async (root) => {
      const accounts = new AccountRepository(root);
      const account = accounts.importAccount(identityAccount({
        passwordHash: fixturePasswordHash("password"),
        totpKey: stored.key,
        ...("encoding" in stored ? { totpKeyEncoding: stored.encoding } : {}),
      }));
      const path = `${root}/accounts.json`;
      const bytes = Deno.readTextFileSync(path);
      const reopened = new AccountRepository(root);
      assertEquals(
        Deno.readTextFileSync(path),
        bytes,
        "decoding must not rewrite history",
      );
      const signing = new SessionRepository(root);
      signing.initialize();
      const sessions = new InstanceSessions(reopened, signing, {
        expirySeconds: 1000,
      }, { now: () => NOW });
      const secret = stored.encoding === "base32"
        ? stored.key
        : base32(utf8(stored.key));
      const code = await authenticatorCode(secret, NOW);
      const input = { username: "alice", password: "password", totp: code };
      const token = await sessions.login(input);
      assertEquals(
        (await sessions.validateToken(token.access_token)).accountId,
        account.id,
      );
      const restarted = new InstanceSessions(
        new AccountRepository(root),
        new SessionRepository(root),
        { expirySeconds: 1000 },
        { now: () => NOW },
      );
      await assertRejects(() => restarted.login(input), AuthenticationError);
      const nextCode = await authenticatorCode(secret, NOW + 30_000);
      await restarted.login({ ...input, totp: nextCode });
      const saved = restarted.accounts.byId(account.id)!;
      assertEquals(saved.totpKey, stored.key);
      assertEquals(saved.totpKeyEncoding, stored.encoding);
      assertEquals(
        Object.hasOwn(saved, "totpKeyEncoding"),
        "encoding" in stored,
      );
      assertEquals(saved.lastTotpStep, NOW / 30_000 + 1);
      const reset = restarted.accounts.changeCredentials(account.id, 0, {
        passwordHash: fixturePasswordHash("new password"),
      }, UPDATE);
      assertEquals(reset.totpKey, stored.key);
      assertEquals(reset.totpKeyEncoding, stored.encoding);
      assertEquals(reset.lastTotpStep, saved.lastTotpStep);
    }));

  Deno.test(`stored TOTP upgrade: legacy cold-start login reads note without rewriting ${JSON.stringify(stored)}`, () =>
    identityFixture(async (vault, rootScope) => {
      await Deno.mkdir(`${vault}/.globnotes`);
      const path = `${vault}/.globnotes/config.json`;
      const bytes = JSON.stringify(
        {
          auth_type: "totp",
          username: "alice",
          password_hash: fixturePasswordHash("password"),
          secret_key: "stored-secret-key",
          totp_key: stored.key,
          ...("encoding" in stored
            ? { totp_key_encoding: stored.encoding }
            : {}),
        },
        null,
        2,
      ) + "\n";
      await Deno.writeTextFile(path, bytes);
      await Deno.writeTextFile(
        `${vault}/SecretProbe.md`,
        "# Secret Probe\n\nOriginal authenticator note bytes.\n",
      );
      for (const restart of [false, true]) {
        await fixtureScope(async (scope) => {
          const server = await scope.acquire(
            () => bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault }),
            (server) => server.close(),
          );
          await rootScope.admit(async () => {
            assertEquals(await Deno.readTextFile(path), bytes);
            const denied = await fetch(
              `${server.value.baseUrl}/_/api/notes/SecretProbe`,
            );
            await denied.body?.cancel();
            assertEquals(denied.status, 401);
            const secret = stored.encoding === "base32"
              ? stored.key
              : base32(utf8(stored.key));
            const now = await settledTotpNow();
            const code = await authenticatorCode(secret, now);
            const response = await fetch(
              `${server.value.baseUrl}/_/api/token`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  username: "alice",
                  password: "password" + code,
                }),
              },
            );
            const result = await response.json();
            assertEquals(
              response.status,
              200,
              JSON.stringify({ restart, result }),
            );
            assert(typeof result.access_token === "string");
            const note = await fetch(
              `${server.value.baseUrl}/_/api/notes/SecretProbe`,
              { headers: { Authorization: `Bearer ${result.access_token}` } },
            );
            const content = await note.json();
            assertEquals(note.status, 200);
            assertEquals(
              content.content,
              "# Secret Probe\n\nOriginal authenticator note bytes.\n",
            );
            const replay = await fetch(`${server.value.baseUrl}/_/api/token`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                username: "alice",
                password: "password" + code,
              }),
            });
            await replay.body?.cancel();
            assertEquals(replay.status, 401);
            assertEquals(await Deno.readTextFile(path), bytes);
          }, scope);
        });
      }
      assertEquals(await Deno.readTextFile(path), bytes);
    }));
}
