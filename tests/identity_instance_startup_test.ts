// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { openInstanceIdentity } from "../server/auth/instance.ts";
import { IdentityRecoveryError } from "../server/auth/bootstrap.ts";
import { IdentityOwnershipError } from "../server/auth/ownership.ts";
import { IdentityTransactionUnavailable } from "../server/auth/transaction.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { AuthenticationError } from "../server/auth/account_credentials.ts";
import { OwnershipError } from "../shared/ownership.js";
import type { PluginManager } from "../server/plugins/manager.ts";
import { fixturePasswordHash, GlobalConfig } from "./helpers/config.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { identityFixture, UPDATE, VAULT_A } from "./helpers/identity.ts";
import { transactionContext } from "./helpers/identity_transaction.ts";
import { recoveryForRoot } from "./helpers/account_preparation.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import type { FixtureScope } from "./helpers/fixture_scope.ts";

const release = { version: "fixture", revision: "startup" };
const recovery =
  "Identity state requires offline operator recovery or explicit migration; public setup is unavailable.";
const plugins = (): PluginManager => {
  throw new Error("Startup must not start or read plugins.");
};
function configuration(
  root: string,
  seed = false,
  declared = false,
  password = "private",
) {
  Deno.mkdirSync(`${root}/notes`, { recursive: true });
  return new GlobalConfig(testEnvironment({
    GLOBNOTES__VAULTS_BASEPATH: `${root}/base`,
    GLOBNOTES__METADATA_PATH: `${root}/metadata`,
    GLOBNOTES_GLOBNOTES_PATH: `${root}/notes`,
    ...(seed
      ? {
        GLOBNOTES__ACCOUNTS_FIRST_LOGIN: "Alice",
        GLOBNOTES__ACCOUNTS_FIRST_PASSWORD: password,
      }
      : {}),
    ...(declared ? { GLOBNOTES_GLOBNOTES_ADMIN: "alice" } : {}),
    fixtureStatePath: `${root}/metadata/_/vault`,
  }));
}
async function opened(scope: FixtureScope, config: GlobalConfig) {
  return (await scope.acquire(
    () => openInstanceIdentity(config, plugins, release),
    (instance) => instance.close(),
  )).value;
}
function present(filename: string) {
  try {
    return Deno.readTextFileSync(filename);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

for (const phase of ["account", "signing", "active"] as const) {
  Deno.test(`instance startup: resumes configured seed interrupted after ${phase} publication`, () =>
    identityFixture(async (root, scope) => {
      const config = configuration(root, true);
      const accounts = `${config.resolved.instancePath}/accounts.json`;
      const signing = `${config.resolved.instancePath}/sessions.json`;
      const access = `${config.statePath}/access.json`;
      const interruption = new Error("configured seed interrupted");
      assertStrictEquals(
        await assertRejects(
          () =>
            openInstanceIdentity(config, plugins, release, {
              seedCheckpoint(at) {
                if (at === phase) throw interruption;
              },
            }),
          Error,
          interruption.message,
        ),
        interruption,
      );
      const before = JSON.parse(present(accounts)!);
      const originalSigning = present(signing);
      assertEquals([
        before.configuredSeedPending,
        originalSigning === null,
        present(access),
      ], [phase === "active" ? undefined : true, phase === "account", null]);
      if (phase !== "active") {
        // Neither a missing declaration nor a non-matching password may
        // initialize signing, clear the marker, or open web setup.
        for (
          const wrong of [
            configuration(root),
            configuration(root, true, false, "changed"),
          ]
        ) {
          await assertRejects(
            () => openInstanceIdentity(wrong, plugins, release),
            IdentityRecoveryError,
            recovery,
          );
          assertEquals([
            JSON.parse(present(accounts)!),
            present(signing),
            present(access),
          ], [before, originalSigning, null]);
        }
      }
      const resumed = await opened(scope, config);
      const { principal } = await signIn(resumed.sessions, {
        username: "alice",
        password: "private",
      });
      const after = JSON.parse(present(accounts)!);
      assertEquals([
        resumed.bootstrap.status(),
        after.configuredSeedPending,
        after.accounts,
        principal.accountId,
        resumed.acl.effectiveLevel(principal),
        present(access),
      ], [
        { setupRequired: false },
        undefined,
        before.accounts,
        before.accounts[0].id,
        "none",
        null,
      ]);
      if (originalSigning !== null) {
        assertEquals(present(signing), originalSigning);
      }
    }));
}

Deno.test("instance startup: fresh preparation binds one target without creating credentials or starting services", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root);
    const instance = await opened(scope, config);
    assertStrictEquals(instance.sessions.accounts, instance.accounts);
    assertStrictEquals(
      instance.composition.authority.sessions,
      instance.sessions,
    );
    assertStrictEquals(instance.composition.vault.acl, instance.acl);
    assertStrictEquals(
      instance.composition.lifecycle,
      instance.composition.vault.lifecycle,
    );
    assertStrictEquals(
      instance.composition.authority.lifetime,
      instance.lifetime,
    );
    assertEquals([
      instance.bootstrap.status(),
      instance.composition.lifecycle.operational(),
      instance.composition.lifecycle.writable(),
      present(`${config.resolved.instancePath}/accounts.json`),
      present(`${config.resolved.instancePath}/sessions.json`),
      present(`${config.statePath}/access.json`),
    ], [{ setupRequired: true }, false, false, null, null, null]);
    assertEquals(
      JSON.parse(present(`${config.resolved.instancePath}/single-vault.json`)!)
        .id,
      instance.binding.id,
    );
    const close = instance.close();
    assertStrictEquals(instance.close(), close);
    assertThrows(
      () => instance.lifetime.assertCurrent(),
      OwnershipError,
      "Owner is retired",
    );
    await close;
    const next = await opened(scope, config);
    assertEquals(next.binding, instance.binding);
  }));

for (const declared of [false, true]) {
  Deno.test(`instance startup: configured account signs in normally, with only explicit Admin declaration (${declared})`, () =>
    identityFixture(async (root, scope) => {
      const config = configuration(root, true, declared);
      const instance = await opened(scope, config);
      const token = await signIn(instance.sessions, {
        username: "alice",
        password: "private",
      });
      assertEquals([
        instance.bootstrap.status(),
        instance.accounts.capture().value.accounts.map((
          a,
        ) => [a.login, a.passwordChangeRequired]),
        instance.acl.effectiveLevel(token.principal),
        instance.composition.lifecycle.operational(),
        instance.composition.lifecycle.writable(),
        instance.acl.capture().value.grants,
        present(`${config.statePath}/access.json`),
      ], [
        { setupRequired: false },
        [["alice", false]],
        declared ? "admin" : "none",
        true,
        true,
        {},
        null,
      ]);
      const response = await instance.composition.responses.status(
        new Request("http://globnotes.test/_/api/auth-check", {
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      );
      const status = await response.json();
      assertEquals([
        status.setupRequired,
        status.principal.id,
        status.capabilities.canManageOwnAccount,
      ], [false, token.principal.accountId, true]);
    }));
}

Deno.test("instance startup: web setup publishes the account and chosen ACL, then restart retains both", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root);
    const instance = await opened(scope, config);
    const issued = await instance.bootstrap.setup({
      username: "alice",
      password: "private",
      everybody: "view",
      updateId: UPDATE,
    });
    const handoff = await new Response(issued.body).json();
    assertEquals([
      handoff.vaultId,
      handoff.everybody,
      instance.acl.effectiveLevel(issued.principal),
    ], [instance.binding.id, "view", "admin"]);
    const paths = [
      `${config.resolved.instancePath}/accounts.json`,
      `${config.resolved.instancePath}/sessions.json`,
      `${config.statePath}/access.json`,
      `${config.resolved.instancePath}/single-vault.json`,
    ];
    const before = paths.map(present);
    await instance.close();
    const reopened = await opened(scope, config);
    const token = await signIn(reopened.sessions, {
      username: "alice",
      password: "private",
    });
    assertEquals([
      reopened.bootstrap.status(),
      reopened.binding.id,
      reopened.acl.effectiveLevel(token.principal),
      reopened.acl.effectiveLevel({ kind: "guest" }),
      paths.map(present),
    ], [
      { setupRequired: false },
      instance.binding.id,
      "admin",
      "view",
      before,
    ]);
  }));

Deno.test("instance startup: changed credentials and token revocation survive restart, not seed synchronization", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root, true);
    const instance = await opened(scope, config);
    const token = await signIn(instance.sessions, {
      username: "alice",
      password: "private",
    });
    const result = await new Response(
      await instance.account.change(token.principal, {
        revision: token.principal.credentialRevision,
        updateId: UPDATE,
        currentPassword: "private",
        newPassword: "changed",
      }),
    ).json();
    assertEquals(result.requiresLogin, true);
    await instance.close();
    const reopened = await opened(scope, config);
    const token2 = await signIn(reopened.sessions, {
      username: "alice",
      password: "changed",
    });
    assertEquals([
      token2.principal.accountId,
      reopened.bootstrap.status(),
      reopened.accounts.capture().value.accounts.length,
    ], [token.principal.accountId, { setupRequired: false }, 1]);
    await assertRejects(
      () => reopened.sessions.validateToken(token.access_token),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    await assertRejects(
      () => reopened.sessions.login({ username: "alice", password: "private" }),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
  }));

for (const filename of ["accounts.json", "sessions.json"]) {
  Deno.test(`instance startup: missing initialized ${filename} cannot reapply seed or reopen setup`, () =>
    identityFixture(async (root, scope) => {
      const config = configuration(root, true);
      const instance = await opened(scope, config);
      await instance.close();
      Deno.removeSync(`${config.resolved.instancePath}/${filename}`);
      const other = filename === "accounts.json"
        ? "sessions.json"
        : "accounts.json";
      const before = present(`${config.resolved.instancePath}/${other}`);
      await assertRejects(
        () => openInstanceIdentity(config, plugins, release),
        IdentityRecoveryError,
        recovery,
      );
      assertEquals([
        present(`${config.resolved.instancePath}/${filename}`),
        present(`${config.resolved.instancePath}/${other}`),
      ], [null, before]);
      const recovered = recoveryForRoot(config.resolved.instancePath);
      recovered.close();
    }));
}

for (
  const contents of [
    '{"auth_type":"none","secret_key":"keep"}',
    '{"username":"alice","totp_key":"historical"}',
    "{bad",
  ]
) {
  Deno.test(`instance startup: legacy or malformed input stays intact and cannot become takeover setup (${contents.length})`, () =>
    identityFixture(async (root) => {
      const config = configuration(root, true);
      const filename = `${config.statePath}/config.json`;
      Deno.writeTextFileSync(filename, contents);
      await assertRejects(
        () => openInstanceIdentity(config, plugins, release),
        IdentityRecoveryError,
        recovery,
      );
      assertEquals([
        present(filename),
        present(`${config.resolved.instancePath}/single-vault.json`),
        present(`${config.resolved.instancePath}/accounts.json`),
        present(`${config.resolved.instancePath}/sessions.json`),
      ], [contents, null, null, null]);
      const recovered = recoveryForRoot(config.resolved.instancePath);
      recovered.close();
    }));
}

Deno.test("instance startup: exclusive ownership refuses a second opener and retains the lock inode after close", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root);
    const instance = await opened(scope, config);
    const filename = `${config.resolved.instancePath}/identity.lock`;
    const before = Deno.statSync(filename);
    await assertRejects(
      () => openInstanceIdentity(config, plugins, release),
      IdentityOwnershipError,
      "Identity state has another live owner; stop it before recovery.",
    );
    await instance.close();
    const reopened = await opened(scope, config);
    assertEquals([Deno.statSync(filename).ino, Deno.statSync(filename).dev], [
      before.ino,
      before.dev,
    ]);
    reopened.lifetime.assertCurrent();
  }));

Deno.test("instance startup: seed failure and cancellation release the lock and publish no credentials", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root, true);
    const failure = new Error("hash refused");
    assertStrictEquals(
      await assertRejects(
        () =>
          openInstanceIdentity(config, plugins, release, {
            credentials: { hash: () => Promise.reject(failure) },
          }),
        Error,
        "hash refused",
      ),
      failure,
    );
    const abort = new AbortController();
    await heldOperation({
      label: "startup seed hash",
      owner: () => config,
      progress: { kind: "controlled", clock: "external" },
    }, (hold) =>
      openInstanceIdentity(config, plugins, release, {
        signal: abort.signal,
        credentials: {
          hash: async (password) => {
            await hold();
            return fixturePasswordHash(password);
          },
        },
      }), async (held) => {
      await held.reached();
      abort.abort(failure);
      assertStrictEquals(
        await assertRejects(() => held.result(), Error, "hash refused"),
        failure,
      );
    });
    assertEquals([
      present(`${config.resolved.instancePath}/accounts.json`),
      present(`${config.resolved.instancePath}/sessions.json`),
    ], [null, null]);
    const instance = await opened(scope, config);
    assertEquals(instance.bootstrap.status(), { setupRequired: false });
  }));

Deno.test("instance startup: a decided setup recovers before binding and normal sign-in", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root);
    const interrupted = new Error("decided interruption");
    const f = transactionContext(
      config.resolved.instancePath,
      scope,
      (phase) => {
        if (phase === "decided") throw interrupted;
      },
    );
    f.signing.initialize();
    const staged = await f.stage();
    const error = assertThrows(
      () => f.transaction.commit(staged.meta, staged.parts, f.lease),
      IdentityTransactionUnavailable,
      "Identity publication requires recovery; no partial state is available.",
    );
    assertStrictEquals(error.cause, interrupted);
    f.retire();
    const instance = await opened(scope, config);
    const token = await signIn(instance.sessions, {
      username: "alice",
      password: "password",
    });
    assertEquals([
      instance.bootstrap.status(),
      instance.binding.id,
      instance.acl.effectiveLevel(token.principal),
      instance.acl.effectiveLevel({ kind: "guest" }),
      present(`${config.resolved.instancePath}/identity-transaction.json`),
    ], [{ setupRequired: false }, VAULT_A, "admin", "view", null]);
  }));

Deno.test("instance startup: a different persisted binding refuses journal replay before either participant changes", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root);
    const f = transactionContext(
      config.resolved.instancePath,
      scope,
      (phase) => {
        if (phase === "decided") throw new Error("decided interruption");
      },
    );
    f.signing.initialize();
    const staged = await f.stage();
    assertThrows(
      () => f.transaction.commit(staged.meta, staged.parts, f.lease),
      IdentityTransactionUnavailable,
      "Identity publication requires recovery; no partial state is available.",
    );
    f.retire();
    const binding = `${config.resolved.instancePath}/single-vault.json`;
    Deno.writeTextFileSync(
      binding,
      JSON.stringify({
        version: 1,
        id: UPDATE,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const paths = [
      binding,
      `${config.resolved.instancePath}/accounts.json`,
      `${config.resolved.instancePath}/sessions.json`,
      `${config.statePath}/access.json`,
      `${config.resolved.instancePath}/identity-transaction.json`,
    ];
    const before = paths.map(present);
    await assertRejects(
      () => openInstanceIdentity(config, plugins, release),
      IdentityRecoveryError,
      recovery,
    );
    assertEquals(paths.map(present), before);
    const recovered = recoveryForRoot(config.resolved.instancePath);
    recovered.close();
  }));

Deno.test("instance startup: after journal unlink the original replay keeps the lock until confirmation", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root);
    const f = transactionContext(
      config.resolved.instancePath,
      scope,
      (phase) => {
        if (phase === "decided") throw new Error("stop before publication");
      },
    );
    f.signing.initialize();
    const staged = await f.stage();
    assertThrows(
      () => f.transaction.commit(staged.meta, staged.parts, f.lease),
      IdentityTransactionUnavailable,
    );
    f.retire();
    const journal = `${config.resolved.instancePath}/identity-transaction.json`;
    const attempts: (string | null)[] = [];
    try {
      await assertRejects(
        () =>
          openInstanceIdentity(config, plugins, release, {
            recoveryCheckpoint(phase) {
              if (phase !== "journal-unlinked") return;
              attempts.push(present(journal));
              if (attempts.length === 1) {
                throw new Error("directory confirmation failed");
              }
            },
          }),
        IdentityTransactionUnavailable,
        "no partial state is available",
      );
      assertEquals([present(journal), attempts], [null, [null]]);
      assertThrows(
        () => recoveryForRoot(config.resolved.instancePath),
        IdentityOwnershipError,
      );
    } finally {
      const instance = await opened(scope, config);
      const { principal } = await signIn(instance.sessions, {
        username: "alice",
        password: "password",
      });
      assertEquals([
        attempts,
        instance.acl.effectiveLevel(principal),
        present(journal),
      ], [[null, null], "admin", null]);
    }
  }));

Deno.test("instance startup: closing fences an already prepared private response and retires credential issuance", () =>
  identityFixture(async (root, scope) => {
    const config = configuration(root, true);
    const instance = await opened(scope, config);
    const token = await signIn(instance.sessions, {
      username: "alice",
      password: "private",
    });
    const response = await instance.composition.responses.status(
      new Request("http://globnotes.test/_/api/auth-check", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
    );
    const issued = await instance.sessions.login({
      username: "alice",
      password: "private",
    });
    const closing = instance.close();
    await assertRejects(
      () => response.text(),
      OwnershipError,
      "Owner is retired",
    );
    await assertRejects(
      () => new Response(issued.body).text(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    await closing;
    const replacement = await opened(scope, config);
    const current = await signIn(replacement.sessions, {
      username: "alice",
      password: "private",
    });
    assertStrictEquals(instance.lifetime === replacement.lifetime, false);
    assertEquals(current.principal.accountId, token.principal.accountId);
    await assertRejects(
      () => instance.sessions.login({ username: "alice", password: "private" }),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    assertThrows(
      () => instance.lifetime.assertCurrent(),
      OwnershipError,
      "Owner is retired",
    );
  }));

Deno.test("instance startup: corrupt stores remain evidence and failed construction releases exclusive ownership", () =>
  identityFixture(async (root) => {
    const config = configuration(root);
    Deno.mkdirSync(config.resolved.instancePath, { recursive: true });
    const filename = `${config.resolved.instancePath}/accounts.json`;
    Deno.writeTextFileSync(filename, "{}");
    await assertRejects(
      () => openInstanceIdentity(config, plugins, release),
      IdentityStateError,
      "Invalid identity state; original bytes retained.",
    );
    assertEquals(present(filename), "{}");
    const recovered = recoveryForRoot(config.resolved.instancePath);
    recovered.close();
  }));
