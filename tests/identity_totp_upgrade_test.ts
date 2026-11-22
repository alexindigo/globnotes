// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
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

for (const lane of ["access", "setup"]) {
  Deno.test(`stored TOTP replacement: legacy ${lane} confirms only its issued canonical replacement and removes both fields`, () =>
    identityFixture(async (vault, rootScope) => {
      await Deno.mkdir(`${vault}/.globnotes`);
      const path = `${vault}/.globnotes/config.json`;
      const oldKey = "A".repeat(32);
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
      const enrollment = await call(`${lane}/totp-enrolment`, "POST", {
        username: "alice",
      }, token);
      assertEquals(enrollment.status, 200);
      const peer = await call(`${lane}/totp-enrolment`, "POST", {
        username: "alice",
      }, token);
      assertEquals(peer.status, 200);
      const newKey = enrollment.body.key;
      const newSecret = enrollment.body.secret;
      assertEquals(newKey, newSecret);
      const newCode = await clock.value.code(newSecret);
      const current = lane === "access"
        ? (await call("access", "GET", undefined, token)).body
        : null;
      const change = {
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
      };
      const original = await Deno.readTextFile(path);
      for (const rejectedKey of ["unissued raw key"]) {
        const rejected = await call(lane, lane === "access" ? "PUT" : "POST", {
          ...change,
          totpKey: rejectedKey,
        }, token);
        assertEquals(rejected.status, 422);
        assertEquals(await Deno.readTextFile(path), original);
      }
      // Independent issuance is not retirement. The peer candidate still
      // requires its own code; its key cannot borrow this attempt's proof.
      const wrongProof = await call(lane, lane === "access" ? "PUT" : "POST", {
        ...change,
        totpKey: peer.body.key,
        totpCode: "",
      }, token);
      assertEquals(wrongProof.status, 400);
      assertEquals(await Deno.readTextFile(path), original);
      const replaced = await call(
        lane,
        lane === "access" ? "PUT" : "POST",
        change,
        token,
      );
      assertEquals(
        replaced.status,
        200,
        JSON.stringify({ response: replaced.body, logs: server.value.logs() }),
      );
      const saved = JSON.parse(await Deno.readTextFile(path));
      assertEquals([saved.totp_key, saved.totp_key_encoding], [
        newKey,
        "base32",
      ]);
      await clock.value.advanceStep();
      const signedIn = await login(await clock.value.code(newSecret));
      assertEquals(signedIn.status, 200);
      token = signedIn.body.access_token;
      assertEquals(
        (await call("auth-check", "GET", undefined, token)).status,
        200,
      );
      let view = (await call("access", "GET", undefined, token)).body;
      let activeSecret = newSecret;
      await clock.value.advanceStep();
      if (lane === "access") {
        const beforeReuse = await Deno.readTextFile(path);
        const replacement = {
          mode: "password",
          totpEnabled: true,
          revision: view.revision,
          signature: view.signature,
          currentPassword: "password",
          currentTotp: await clock.value.code(newSecret),
        };
        const consumed = await call("access", "PUT", {
          ...replacement,
          totpKey: newKey,
          totpCode: await clock.value.code(newSecret),
        }, token);
        assertEquals(consumed.status, 422);
        assertEquals(await Deno.readTextFile(path), beforeReuse);
        const peerCompletion = await call("access", "PUT", {
          ...replacement,
          totpKey: peer.body.key,
          totpCode: await clock.value.code(peer.body.secret),
        }, token);
        assertEquals(peerCompletion.status, 200);
        const peerSaved = JSON.parse(await Deno.readTextFile(path));
        assertEquals([peerSaved.totp_key, peerSaved.totp_key_encoding], [
          peer.body.key,
          "base32",
        ]);
        activeSecret = peer.body.secret;
        await clock.value.advanceStep();
        const peerSignIn = await login(await clock.value.code(activeSecret));
        assertEquals(peerSignIn.status, 200);
        token = peerSignIn.body.access_token;
        view = (await call("access", "GET", undefined, token)).body;
        await clock.value.advanceStep();
      }
      const removed = await call("access", "PUT", {
        mode: "password",
        totpEnabled: false,
        revision: view.revision,
        signature: view.signature,
        currentPassword: "password",
        currentTotp: await clock.value.code(activeSecret),
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
