// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  setupScenario,
  signedInScenario,
} from "./helpers/fixture_scenarios.ts";
import { encodeBase32 } from "@std/encoding/base32";
import { AccountRepository } from "../server/auth/accounts.ts";
import { reduceAccountCredentials } from "../server/auth/internal/credential_reducer.ts";
import { decodeStoredAuthenticator } from "../server/auth/credentials.ts";
import {
  disableFixtureAuthenticator,
  importFixtureAccount,
  resetFixturePassword,
} from "./helpers/account_preparation.ts";
import { storedAccount } from "./helpers/identity.ts";
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
      const original = identityAccount({
        passwordHash: fixturePasswordHash("password"),
        totpKey: "A".repeat(32),
        totpKeyEncoding: "base32",
        lastTotpStep: 100,
      });
      // Arbitrary historical stored values are a reducer/import contract, not
      // ordinary enrollment input. The live commands accept only issued keys.
      const changed = reduceAccountCredentials(
        original,
        decodeStoredAuthenticator(
          original.totpKey,
          original.totpKeyEncoding,
          original.lastTotpStep,
        ),
        decodeStoredAuthenticator(replacement.key, replacement.encoding, null),
        UPDATE,
      );
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
      importFixtureAccount(accounts, changed);
      const reopened = new AccountRepository(root, undefined, {
        now: () => NOW,
      });
      assertEquals(storedAccount(reopened, original.id), changed);
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
      await disableFixtureAuthenticator(reopened, original.id, UPDATE);
      const removed = storedAccount(reopened, original.id);
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
      const cleared = new AccountRepository(root, undefined, {
        now: () => NOW,
      });
      assertEquals(cleared.byId(original.id), {
        id: removed.id,
        login: removed.login,
        credentialRevision: removed.credentialRevision,
        passwordChangeRequired: removed.passwordChangeRequired,
        credentialUpdateId: removed.credentialUpdateId,
        totpEnabled: false,
      });
      const passwordOnly = await signIn(
        new InstanceSessions(cleared, new SessionRepository(root), {
          expirySeconds: 1000,
        }, { now: () => NOW }),
        { username: "alice", password: "password" },
      );
      assertEquals(
        (await sessions.validateToken(passwordOnly.access_token)).accountId,
        original.id,
      );
    }));
}

Deno.test("stored TOTP upgrade: effective legacy aliases retain the persisted replay floor", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    const account = identityAccount({
      totpKey: "key",
      lastTotpStep: 100,
    });
    const next = reduceAccountCredentials(
      account,
      decodeStoredAuthenticator(account.totpKey, undefined, 100),
      decodeStoredAuthenticator("key\0", undefined, null),
      UPDATE,
    );
    importFixtureAccount(accounts, next);
    assertEquals(storedAccount(accounts, account.id).lastTotpStep, 100);
    assertEquals(
      storedAccount(new AccountRepository(root), account.id).lastTotpStep,
      100,
    );
  }));

for (const setup of [false, true]) {
  Deno.test(`stored TOTP: ${setup ? "first setup" : "existing account"} installs only the latest issued key and Account removes it across restart`, () =>
    identityFixture(async (vault, scope) => {
      const oldKey = "A".repeat(32), username = "alice", password = "password";
      const clock = (await scope.acquire(() =>
        createNativeTotpClock(vault, NOW), (clock) =>
        clock.close())).value;
      const env = {
        GLOBNOTES_GLOBNOTES_PATH: vault,
        GLOBNOTES__VAULTS_BASEPATH: vault,
        ...setup ? {} : {
          fixtureScenario: signedInScenario({
            login: username,
            password,
            totpKey: oldKey,
            totpKeyEncoding: "base32",
          }),
        },
      };
      const boot = () =>
        scope.acquire(() =>
          bootServer(env, { denoArgs: clock.denoArgs }), (server) =>
          server.close());
      let server = (await boot()).value;
      const file = `${vault}/.globnotes/accounts.json`;
      async function call(
        path: string,
        method = "GET",
        data?: unknown,
        token?: string,
      ) {
        const response = await fetch(`${server.baseUrl}/_/api/${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        return { status: response.status, body: await response.json() };
      }
      const login = (totp?: string) =>
        call("token", "POST", { username, password, totp });
      let token: string | undefined;
      if (!setup) {
        const before = await login(await clock.code(oldKey));
        assertEquals(before.status, 200);
        token = before.body.access_token;
        await clock.advanceStep();
      }
      const route = setup ? "setup" : "account",
        method = setup ? "POST" : "PATCH";
      const enroll = () =>
        call(
          `${route}/totp-enrolment`,
          "POST",
          setup ? { username } : undefined,
          token,
        );
      const previous = await enroll(), current = await enroll();
      assertEquals([previous.status, current.status, current.body.key], [
        200,
        200,
        current.body.secret,
      ]);
      const code = await clock.code(current.body.secret);
      const original = setup ? null : await Deno.readTextFile(file);
      const update = setup ? { username, password, everybody: "none" } : {
        revision: (await call("account", "GET", undefined, token)).body
          .credentialRevision,
        currentPassword: password,
        currentTotp: await clock.code(oldKey),
      };
      const change = (key: string, confirmation: string) =>
        call(route, method, {
          ...update,
          updateId: crypto.randomUUID(),
          totp: { key, code: confirmation, ...setup ? {} : { enabled: true } },
        }, token);
      for (const key of ["unissued raw key", previous.body.key]) {
        const stale = await change(key, code);
        assertEquals(stale.status, 422);
        if (setup) {
          await assertRejects(() =>
            Deno.readTextFile(file), Deno.errors.NotFound);
        } else assertEquals(await Deno.readTextFile(file), original);
      }
      const replaced = await change(current.body.key, code);
      assertEquals(replaced.status, 200);
      const [account] = JSON.parse(await Deno.readTextFile(file)).accounts;
      assertEquals([account.totpKey, account.totpKeyEncoding], [
        current.body.key,
        "base32",
      ]);
      assertEquals((await login(code)).status, 401);
      if (token) {
        assertEquals(
          (await call("account", "GET", undefined, token)).status,
          401,
        );
      }
      await clock.advanceStep();
      const signed = await login(await clock.code(current.body.secret));
      assertEquals(signed.status, 200);
      token = signed.body.access_token;
      await clock.advanceStep();
      const remove = await call("account", "PATCH", {
        revision: (await call("account", "GET", undefined, token)).body
          .credentialRevision,
        updateId: crypto.randomUUID(),
        currentPassword: password,
        currentTotp: await clock.code(current.body.secret),
        totp: { enabled: false },
      }, token);
      assertEquals(remove.status, 200);
      const [cleared] = JSON.parse(await Deno.readTextFile(file)).accounts;
      assertEquals([
        cleared.totpKey,
        cleared.totpKeyEncoding,
        cleared.lastTotpStep,
      ], [null, undefined, null]);
      await server.close();
      server = (await boot()).value;
      assertEquals((await login()).status, 200);
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
      const account = identityAccount({
        totpKey: control.left,
        lastTotpStep: 100,
        passwordHash: fixturePasswordHash("password"),
      });
      const next = reduceAccountCredentials(
        account,
        decodeStoredAuthenticator(control.left, undefined, 100),
        decodeStoredAuthenticator(
          control.right,
          control.marked ? "base32" : undefined,
          null,
        ),
        UPDATE,
      );
      importFixtureAccount(accounts, next);
      const reopened = new AccountRepository(directory, undefined, {
        now: () => 3_000_000,
      });
      assertEquals(
        storedAccount(reopened, account.id).lastTotpStep,
        control.same ? 100 : null,
      );
      if (control.same) {
        const code = await authenticatorCode(
          control.marked ? control.right : base32(utf8(control.right)),
          3_000_000,
        );
        await assertRejects(
          () => reopened.credentials.authenticate("alice", "password", code),
          AuthenticationError,
          "Invalid authentication credentials.",
        );
      }
      await reopened.credentials.authenticate(
        "alice",
        "password",
        await authenticatorCode(
          control.marked ? control.right : base32(utf8(control.right)),
          3_030_000,
        ),
      );
      assertEquals(
        storedAccount(new AccountRepository(directory), account.id)
          .lastTotpStep,
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
      const account = importFixtureAccount(
        accounts,
        identityAccount({
          passwordHash: fixturePasswordHash("password"),
          totpKey: stored.key,
          ...("encoding" in stored ? { totpKeyEncoding: stored.encoding } : {}),
        }),
      );
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
      const saved = storedAccount(restarted.accounts, account.id);
      assertEquals(saved.totpKey, stored.key);
      assertEquals(saved.totpKeyEncoding, stored.encoding);
      assertEquals(
        Object.hasOwn(saved, "totpKeyEncoding"),
        "encoding" in stored,
      );
      assertEquals(saved.lastTotpStep, NOW / 30_000 + 1);
      await resetFixturePassword(
        restarted.accounts,
        account.id,
        "new password",
        UPDATE,
      );
      const reset = storedAccount(restarted.accounts, account.id);
      assertEquals(reset.totpKey, stored.key);
      assertEquals(reset.totpKeyEncoding, stored.encoding);
      assertEquals(reset.lastTotpStep, saved.lastTotpStep);
    }));

  for (const afterImport of [false, true]) {
    Deno.test(`stored TOTP upgrade: ${afterImport ? "sign-in after import reads notes across restart" : "unimported legacy install refuses to start"} ${JSON.stringify(stored)}`, () =>
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
        const inputs = {
          GLOBNOTES__VAULTS_BASEPATH: vault,
          GLOBNOTES_GLOBNOTES_PATH: vault,
          fixtureScenario: afterImport
            ? signedInScenario({
              login: "alice",
              password: "password",
              totpKey: stored.key,
              ...("encoding" in stored
                ? { totpKeyEncoding: stored.encoding }
                : {}),
            })
            : setupScenario(),
        };
        if (!afterImport) {
          let readiness = 0;
          await assertRejects(
            () =>
              bootServer(inputs, {
                healthFetch(...args) {
                  readiness++;
                  return fetch(...args);
                },
              }),
            Error,
            "exit code 1). stderr:\nAccount migration required; public setup is unavailable.",
          );
          assertEquals(readiness, 0);
          assertEquals(await Deno.readTextFile(path), bytes);
          return;
        }
        const clock = await rootScope.acquire(
          () => createNativeTotpClock(vault, NOW),
          (clock) => clock.close(),
        );
        const secret = stored.encoding === "base32"
          ? stored.key
          : base32(utf8(stored.key));
        const signInAt = async (url: string, now: number) =>
          fetch(`${url}/_/api/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              username: "alice",
              password: "password",
              totp: await authenticatorCode(secret, now),
            }),
          });
        for (const restart of [false, true]) {
          await fixtureScope(async (scope) => {
            const server = await scope.acquire(
              () =>
                bootServer(inputs, {
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
              assertEquals(denied.status, 403);
              if (restart) {
                const replay = await signInAt(
                  server.value.baseUrl,
                  clock.value.now(),
                );
                assertEquals(replay.status, 401);
                await replay.body?.cancel();
                await clock.value.advanceStep();
              }
              const response = await signInAt(
                server.value.baseUrl,
                clock.value.now(),
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
              const replay = await signInAt(
                server.value.baseUrl,
                clock.value.now(),
              );
              await replay.body?.cancel();
              assertEquals(replay.status, 401);
              assertEquals(await Deno.readTextFile(path), bytes);
            }, scope);
          });
        }
        const imported = JSON.parse(
          await Deno.readTextFile(`${vault}/.globnotes/accounts.json`),
        ).accounts[0];
        assertEquals([
          imported.totpKey,
          imported.totpKeyEncoding,
          Object.hasOwn(imported, "totpKeyEncoding"),
        ], [stored.key, stored.encoding, "encoding" in stored]);
        assertEquals(await Deno.readTextFile(path), bytes);
      }));
  }
}
