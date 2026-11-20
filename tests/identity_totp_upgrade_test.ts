// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { encodeBase32 } from "@std/encoding/base32";
import { AccountRepository } from "../server/auth/accounts.ts";
import {
  AuthenticationError,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { bootServer } from "./helpers/boot.ts";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import {
  identityAccount,
  identityFixture,
  UPDATE,
} from "./helpers/identity.ts";

const NOW = 1_800_000_000_000;
const base32 = (bytes: Uint8Array) => encodeBase32(bytes).replace(/=+$/, "");
const utf8 = (text: string) => new TextEncoder().encode(text);

for (
  const replacement of [
    { key: "raw replacement" },
    { key: "B".repeat(32) },
    { key: "explicit UTF-8", encoding: null },
    { key: "C".repeat(32), encoding: "base32" as const },
  ]
) {
  Deno.test(`stored TOTP replacement: key and encoding replace together ${JSON.stringify(replacement)}`, () =>
    identityFixture(async (root) => {
      const accounts = new AccountRepository(root, undefined, {
        now: () => NOW,
      });
      const original = accounts.importAccount(identityAccount({
        passwordHash: fixturePasswordHash("password"),
        totpKey: "A".repeat(32),
        totpKeyEncoding: "base32",
        lastTotpStep: 100,
      }));
      const changed = accounts.changeCredentials(original.id, 0, {
        totpKey: replacement.key,
        ...("encoding" in replacement
          ? { totpKeyEncoding: replacement.encoding }
          : {}),
      }, UPDATE);
      assertEquals(
        changed,
        identityAccount({
          passwordHash: original.passwordHash,
          totpKey: replacement.key,
          ...("encoding" in replacement
            ? { totpKeyEncoding: replacement.encoding }
            : {}),
          lastTotpStep: null,
          credentialRevision: 1,
          credentialUpdateId: UPDATE,
        }),
      );
      const reopened = new AccountRepository(root, undefined, {
        now: () => NOW,
      });
      assertEquals(reopened.byId(original.id), changed);
      const signing = new SessionRepository(root);
      signing.initialize();
      const sessions = new InstanceSessions(reopened, signing, {
        expirySeconds: 1000,
      }, { now: () => NOW });
      const secret = replacement.encoding === "base32"
        ? replacement.key
        : base32(utf8(replacement.key));
      const token = await signIn(sessions, {
        username: "alice",
        password: "password",
        totp: await authenticatorCode(secret, NOW),
      });
      assertEquals(
        (await sessions.validateToken(token.access_token)).accountId,
        original.id,
      );
      const removed = reopened.changeCredentials(original.id, 1, {
        totpKey: null,
      }, UPDATE);
      assertEquals(
        removed,
        identityAccount({
          passwordHash: original.passwordHash,
          totpKey: null,
          lastTotpStep: null,
          credentialRevision: 2,
          credentialUpdateId: UPDATE,
        }),
      );
      assertEquals(Object.hasOwn(removed, "totpKeyEncoding"), false);
      assertEquals(
        new AccountRepository(root).storedAuthenticator(original.id),
        { kind: "none" },
      );
    }));
}

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

for (const lane of ["access", "setup"]) {
  Deno.test(`stored TOTP replacement: legacy ${lane} replaces a marked key as UTF-8 and removes both fields`, () =>
    identityFixture(async (vault, rootScope) => {
      await Deno.mkdir(`${vault}/.globnotes`);
      const path = `${vault}/.globnotes/config.json`;
      const oldKey = "A".repeat(32), newKey = "raw replacement";
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...(lane === "access" ? { auth_type: "totp" } : {}),
          username: "alice",
          password_hash: fixturePasswordHash("password"),
          secret_key: "stored-secret-key",
          totp_key: oldKey,
          totp_key_encoding: "base32",
        }),
      );
      const clock = await rootScope.acquire(
        () => createNativeTotpClock(vault, NOW),
        (clock) => clock.close(),
      );
      const server = await rootScope.acquire(
        () =>
          bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault }, {
            denoArgs: clock.value.denoArgs,
          }),
        (server) => server.close(),
      );
      const call = async (
        route: string,
        method = "GET",
        data?: unknown,
        token?: string,
      ) => {
        const response = await fetch(`${server.value.baseUrl}/_/api/${route}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        return { status: response.status, body: await response.json() };
      };
      const login = (code = "") =>
        call("token", "POST", {
          username: "alice",
          password: "password" + code,
        });
      let token: string | undefined;
      const oldCode = await clock.value.code(oldKey);
      if (lane === "access") {
        const initial = await login(oldCode);
        assertEquals(initial.status, 200);
        token = initial.body.access_token;
        await clock.value.advanceStep();
      }
      const newSecret = base32(utf8(newKey));
      const newCode = await clock.value.code(newSecret);
      const current = lane === "access"
        ? (await call("access", "GET", undefined, token)).body
        : null;
      const replaced = await call(lane, lane === "access" ? "PUT" : "POST", {
        mode: "password",
        username: "alice",
        ...(lane === "setup" ? { password: "password" } : {
          revision: current.revision,
          signature: current.signature,
          currentPassword: "password",
          currentTotp: await clock.value.code(oldKey),
        }),
        totpEnabled: true,
        totpKey: newKey,
        totpCode: newCode,
      }, token);
      assertEquals(
        replaced.status,
        200,
        JSON.stringify({ response: replaced.body, logs: server.value.logs() }),
      );
      const saved = JSON.parse(await Deno.readTextFile(path));
      assertEquals([saved.totp_key, saved.totp_key_encoding], [newKey, null]);
      await clock.value.advanceStep();
      const signedIn = await login(await clock.value.code(newSecret));
      assertEquals(signedIn.status, 200);
      token = signedIn.body.access_token;
      assertEquals(
        (await call("auth-check", "GET", undefined, token)).status,
        200,
      );
      const view = (await call("access", "GET", undefined, token)).body;
      await clock.value.advanceStep();
      const removed = await call("access", "PUT", {
        mode: "password",
        totpEnabled: false,
        revision: view.revision,
        signature: view.signature,
        currentPassword: "password",
        currentTotp: await clock.value.code(newSecret),
      }, token);
      assertEquals(removed.status, 200);
      const cleared = JSON.parse(await Deno.readTextFile(path));
      assertEquals(
        [
          Object.hasOwn(cleared, "totp_key"),
          Object.hasOwn(cleared, "totp_key_encoding"),
        ],
        [false, false],
      );
      const passwordOnly = await login();
      assertEquals(passwordOnly.status, 200);
      assertEquals(
        (await call(
          "auth-check",
          "GET",
          undefined,
          passwordOnly.body.access_token,
        )).status,
        200,
      );
    }));
}

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
      const accounts = new AccountRepository(root, undefined, {
        now: () => NOW,
      });
      const account = accounts.importAccount(identityAccount({
        passwordHash: fixturePasswordHash("password"),
        totpKey: stored.key,
        ...("encoding" in stored ? { totpKeyEncoding: stored.encoding } : {}),
      }));
      const path = `${root}/accounts.json`;
      const bytes = Deno.readTextFileSync(path);
      const reopened = new AccountRepository(root, undefined, {
        now: () => NOW,
      });
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
      const token = await signIn(sessions, input);
      assertEquals(
        (await sessions.validateToken(token.access_token)).accountId,
        account.id,
      );
      const restarted = new InstanceSessions(
        new AccountRepository(root, undefined, { now: () => NOW }),
        new SessionRepository(root),
        { expirySeconds: 1000 },
        { now: () => NOW },
      );
      await assertRejects(() => signIn(restarted, input), AuthenticationError);
      const nextCode = await authenticatorCode(secret, NOW + 30_000);
      await signIn(restarted, { ...input, totp: nextCode });
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

  Deno.test(`stored TOTP upgrade: legacy cold-start sign-in reads note without rewriting ${JSON.stringify(stored)}`, () =>
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
      const clock = await rootScope.acquire(
        () => createNativeTotpClock(vault, NOW),
        (clock) => clock.close(),
      );
      for (const restart of [false, true]) {
        await fixtureScope(async (scope) => {
          const server = await scope.acquire(
            () =>
              bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault }, {
                denoArgs: clock.value.denoArgs,
              }),
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
            const code = await authenticatorCode(secret, clock.value.now());
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
