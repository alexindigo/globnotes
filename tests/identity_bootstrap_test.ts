// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { identityFixture, storedAccount, UPDATE } from "./helpers/identity.ts";
import { bootstrapContext } from "./helpers/identity_bootstrap.ts";
import {
  bootstrapHandlers,
  IdentityMigrationRequired,
  IdentityRecoveryError,
  legacyIdentityPresent,
  openIdentityTransaction,
} from "../server/auth/bootstrap.ts";
import { AuthenticationError } from "../server/auth/account_credentials.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { IdentityTransactionUnavailable } from "../server/auth/transaction.ts";
import { recoveryForRoot } from "./helpers/account_preparation.ts";
import { OwnershipError } from "../shared/ownership.js";
import { StoredConfigConflict } from "../server/config/publication_outcome.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { SessionRepository } from "../server/auth/sessions.ts";
import { signIn } from "./helpers/session_delivery.ts";

const input = (everybody = "view") => ({
  username: "Alice",
  password: "private",
  everybody,
  updateId: UPDATE,
});
const recovery =
  "Identity state requires offline operator recovery or explicit migration; public setup is unavailable.";

for (const everybody of ["edit", "view", "none"] as const) {
  Deno.test(`identity bootstrap: one-screen ${everybody} setup returns the settled session/vault handoff`, () =>
    identityFixture(async (root, scope) => {
      const f = bootstrapContext(root, scope);
      assertEquals(f.bootstrap.status(), { setupRequired: true });
      assertEquals([...Deno.readDirSync(root)], []);
      const issued = await f.bootstrap.setup(input(everybody));
      const body = await new Response(issued.body).json();
      assertEquals(Object.keys(body).sort(), [
        "access_token",
        "everybody",
        "principal",
        "setupRequired",
        "token_type",
        "vaultId",
      ]);
      assertEquals([
        body.everybody,
        body.setupRequired,
        body.vaultId,
        body.principal,
        body.token_type,
      ], [everybody, false, f.acl.vaultId, issued.principal, "bearer"]);
      assertEquals(
        await f.sessions.validateToken(body.access_token),
        issued.principal,
      );
      assertEquals([
        f.bootstrap.status(),
        f.acl.effectiveLevel(issued.principal),
        f.acl.effectiveLevel({ kind: "guest" }),
        f.accounts.capture().value.accounts.map(
          (a) => [a.login, a.passwordChangeRequired],
        ),
      ], [{ setupRequired: false }, "admin", everybody, [["alice", false]]]);
      await assertRejects(
        () => f.bootstrap.setup(input()),
        IdentityRecoveryError,
        recovery,
      );
      f.retire();
      const reopened = bootstrapContext(root, scope);
      const login = await signIn(reopened.sessions, {
        username: "alice",
        password: "private",
      });
      assertEquals(reopened.acl.effectiveLevel(login.principal), "admin");
    }));
}

for (
  const patch of [
    { everybody: "admin" },
    { everybody: undefined },
    { mode: "none" },
    { readOnlySettings: true },
    { username: "guest" },
    { password: "" },
  ]
) {
  Deno.test(`identity bootstrap: invalid setup is inert (${Object.keys(patch).join()}:${String(Object.values(patch)[0])})`, () =>
    identityFixture(async (root, scope) => {
      const f = bootstrapContext(root, scope);
      const error = await assertRejects(
        () => f.bootstrap.setup({ ...input(), ...patch }),
        HttpError,
        "HTTP 422",
      );
      if (error instanceof HttpError) assertEquals(error.status, 422);
      assertEquals([
        f.accounts.initialized,
        f.signing.capture().persistence.raw,
        f.acl.capture().persistence.raw,
      ], [false, null, null]);
      assertEquals(f.bootstrap.status(), { setupRequired: true });
    }));
}

Deno.test("identity bootstrap: issued optional authenticator persists its interpretation/floor without spending a second setup code", () =>
  identityFixture(async (root, scope) => {
    const now = 1_700_000_000_000;
    const f = bootstrapContext(root, scope, {
      now: () => now,
      renderQr: (uri) => Promise.resolve(`qr:${uri}`),
    });
    const retired = await f.bootstrap.enrolment("alice");
    const current = await f.bootstrap.enrolment("alice");
    await assertRejects(
      () =>
        f.bootstrap.setup({
          ...input(),
          totp: { key: retired.key, code: "000000" },
        }),
      HttpError,
      "HTTP 422",
    );
    assertEquals(f.signing.capture().persistence.raw, null);
    const code = await authenticatorCode(current.secret, now);
    const issued = await f.bootstrap.setup({
      ...input(),
      totp: { key: current.key, code },
    });
    const session = await new Response(issued.body).json();
    assertEquals(
      (await f.sessions.validateToken(session.access_token)).accountId,
      issued.principal.accountId,
    );
    const saved = storedAccount(f.accounts, issued.principal.accountId);
    assertEquals([saved.totpKey, saved.totpKeyEncoding, saved.lastTotpStep], [
      current.key,
      "base32",
      Math.floor(now / 30000),
    ]);
    await assertRejects(
      () =>
        f.sessions.login({
          username: "alice",
          password: "private",
          totp: code,
        }),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    f.retire();
    const reopened = bootstrapContext(root, scope, { now: () => now + 30000 });
    const next = await authenticatorCode(current.secret, now + 30000);
    const login = await signIn(reopened.sessions, {
      username: "alice",
      password: "private",
      totp: next,
    });
    assertEquals(reopened.acl.effectiveLevel(login.principal), "admin");
  }));

Deno.test("identity bootstrap: hashing remains outside publication and retired ownership cannot initialize either store", () =>
  identityFixture(async (root, scope) => {
    let pause = () => Promise.resolve();
    const f = bootstrapContext(root, scope, {
      hash: async (password) => {
        await pause();
        return fixturePasswordHash(password);
      },
    });
    await heldOperation({
      label: "first-account hash",
      owner: () => f,
      progress: { kind: "controlled", clock: "external" },
    }, async (hold) => {
      pause = hold;
      return await f.bootstrap.setup(input());
    }, async (work) => {
      await work.reached();
      assertEquals([
        f.accounts.initialized,
        f.signing.capture().persistence.raw,
        f.acl.capture().persistence.raw,
      ], [false, null, null]);
      f.retire();
      await assertRejects(
        () => work.result(),
        OwnershipError,
        "Owner is retired",
      );
      assertEquals([
        f.accounts.initialized,
        f.signing.capture().persistence.raw,
        f.acl.capture().persistence.raw,
      ], [false, null, null]);
    });
  }));

for (
  const state of [
    "signing-only",
    "missing-signing",
    "missing-account",
    "legacy",
    "existing-acl",
  ] as const
) {
  Deno.test(`identity bootstrap: ${state} never reopens public setup`, () =>
    identityFixture(async (root, scope) => {
      if (state === "signing-only") new SessionRepository(root).initialize();
      let f = bootstrapContext(root, scope, {
        legacy: () => state === "legacy",
      });
      if (state === "missing-signing" || state === "missing-account") {
        const issued = await f.bootstrap.setup(input());
        await issued.body.cancel();
        Deno.removeSync(
          `${root}/${
            state === "missing-signing" ? "sessions.json" : "accounts.json"
          }`,
        );
        f.retire();
        f = bootstrapContext(root, scope);
      }
      if (state === "existing-acl") {
        f.acl.save({ everybody: "view", grants: {} }, f.acl.capture(), {
          updateId: UPDATE,
          actorId: null,
        });
      }
      const errorType = state === "legacy"
        ? IdentityMigrationRequired
        : IdentityRecoveryError;
      const message = state === "legacy"
        ? "Account migration required; public setup is unavailable."
        : recovery;
      assertThrows(() => f.bootstrap.status(), errorType, message);
      await assertRejects(
        () => f.bootstrap.setup(input()),
        errorType,
        message,
      );
      await assertRejects(
        () => f.bootstrap.enrolment("alice"),
        errorType,
        message,
      );
    }));
}

Deno.test("identity bootstrap: final HTTP handoff rejects replacement after setup instead of leaking buffered token fields", () =>
  identityFixture(async (root, scope) => {
    const f = bootstrapContext(root, scope);
    const response = await bootstrapHandlers(f.bootstrap).post(
      new Request("http://globnotes.test/_/api/setup", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
    );
    f.retire();
    await assertRejects(
      () => response.json(),
      OwnershipError,
      "Owner is retired",
    );
    const restarted = bootstrapContext(root, scope);
    const session = await signIn(restarted.sessions, {
      username: "alice",
      password: "private",
    });
    assertEquals(restarted.acl.effectiveLevel(session.principal), "admin");
  }));

Deno.test("identity bootstrap: one admitted setup owns the held hash and a concurrent second person is refused", () =>
  identityFixture(async (root, scope) => {
    let pause = () => Promise.resolve();
    const f = bootstrapContext(root, scope, {
      hash: async (password) => {
        await pause();
        return fixturePasswordHash(password);
      },
    });
    await heldOperation({
      label: "original setup hash",
      owner: () => f,
      progress: { kind: "controlled", clock: "external" },
    }, async (hold) => {
      pause = hold;
      return await f.bootstrap.setup(input());
    }, async (work) => {
      await work.reached();
      await assertRejects(
        () => f.bootstrap.setup({ ...input(), username: "bob" }),
        IdentityRecoveryError,
        recovery,
      );
      const result = await work.result();
      const session = await new Response(result.body).json();
      assertEquals([
        f.accounts.capture().value.accounts.map((a) => a.login),
        (await f.sessions.validateToken(session.access_token)).accountId,
      ], [["alice"], result.principal.accountId]);
    });
  }));

for (const key of ["\ud800", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"]) {
  Deno.test(`identity bootstrap: malformed or unissued authenticator is a normal 422 (${JSON.stringify(key)})`, () =>
    identityFixture(async (root, scope) => {
      const f = bootstrapContext(root, scope);
      const error = await assertRejects(
        () => f.bootstrap.setup({ ...input(), totp: { key, code: "000000" } }),
        HttpError,
        "HTTP 422",
      );
      assertEquals([
        error.status,
        f.signing.capture().persistence.raw,
        f.accounts.initialized,
        f.acl.capture().persistence.raw,
      ], [422, null, false, null]);
      assertEquals(f.bootstrap.status(), { setupRequired: true });
    }));
}

Deno.test("identity bootstrap: cancelled setup retains fresh state and the original cancellation error", () =>
  identityFixture(async (root, scope) => {
    const f = bootstrapContext(root, scope),
      abort = new AbortController(),
      reason = new Error("fixture cancelled setup");
    abort.abort(reason);
    assertStrictEquals(
      await assertRejects(
        () => f.bootstrap.setup(input(), abort.signal),
        Error,
        reason.message,
      ),
      reason,
    );
    assertEquals([
      f.bootstrap.status(),
      f.accounts.initialized,
      f.signing.capture().persistence.raw,
      f.acl.capture().persistence.raw,
    ], [{ setupRequired: true }, false, null, null]);
  }));

Deno.test("identity bootstrap: buffered handoff retains its exact ACL until response consumption", () =>
  identityFixture(async (root, scope) => {
    const f = bootstrapContext(root, scope);
    const issued = await f.bootstrap.setup(input());
    f.acl.save({ everybody: "none", grants: {} }, f.acl.capture(), {
      updateId: UPDATE,
      actorId: null,
    });
    await assertRejects(
      () => new Response(issued.body).json(),
      StoredConfigConflict,
      "Stored configuration changed before commit.",
    );
    f.retire();
    const reopened = bootstrapContext(root, scope);
    const session = await signIn(reopened.sessions, {
      username: "alice",
      password: "private",
    });
    assertEquals(reopened.acl.effectiveLevel(session.principal), "none");
  }));

for (const failed of ["signing", "account"] as const) {
  Deno.test(`identity bootstrap: ${failed} publication refusal preserves the correct fresh/recovery classification`, () =>
    identityFixture(async (root, scope) => {
      const f = bootstrapContext(root, scope), link = Deno.linkSync;
      const message = "fixture refused first publication";
      try {
        Deno.linkSync = (from, to) => {
          if (
            String(to).endsWith(
              failed === "signing" ? "sessions.json" : "accounts.json",
            )
          ) throw new Deno.errors.PermissionDenied(message);
          link(from, to);
        };
        await assertRejects(
          () => f.bootstrap.setup(input()),
          failed === "signing"
            ? Deno.errors.PermissionDenied
            : IdentityTransactionUnavailable,
          failed === "signing"
            ? message
            : "Identity publication requires recovery; no partial state is available.",
        );
      } finally {
        Deno.linkSync = link;
      }
      if (failed === "signing") {
        assertEquals([
          f.bootstrap.status(),
          f.accounts.initialized,
          f.acl.capture().persistence.raw,
        ], [{ setupRequired: true }, false, null]);
      } else {
        f.retire();
        const next = bootstrapContext(root, scope);
        assertThrows(
          () => next.bootstrap.status(),
          IdentityTransactionUnavailable,
          "Identity publication requires recovery; no partial state is available.",
        );
        const recoveryOwner = recoveryForRoot(root);
        scope.defer(() => recoveryOwner.close());
        next.bootstrap.transaction!.recover(recoveryOwner.authority);
        assertEquals(next.bootstrap.status(), { setupRequired: false });
        const login = await signIn(next.sessions, {
          username: "alice",
          password: "private",
        });
        assertEquals(next.acl.effectiveLevel(login.principal), "admin");
      }
    }));
}

Deno.test("identity bootstrap: actual legacy/corrupt input remains intact, and an initialized empty account file never becomes setup", () =>
  identityFixture(async (root, scope) => {
    const filename = `${root}/config.json`;
    for (
      const bytes of [
        '{"auth_type":"none"}',
        '{"password_hash":"fixture-secret"}',
        "{bad",
      ]
    ) {
      Deno.writeTextFileSync(filename, bytes);
      const f = bootstrapContext(root, scope, {
        legacy: () => legacyIdentityPresent([filename]),
      });
      const migration = bytes !== "{bad";
      assertThrows(
        () => f.bootstrap.status(),
        migration ? IdentityMigrationRequired : IdentityRecoveryError,
        migration
          ? "Account migration required; public setup is unavailable."
          : recovery,
      );
      assertEquals(Deno.readTextFileSync(filename), bytes);
      f.retire();
    }
    Deno.removeSync(filename);
    const f = bootstrapContext(root, scope);
    const issued = await f.bootstrap.setup(input());
    await issued.body.cancel();
    const accounts = `${root}/accounts.json`,
      value = JSON.parse(Deno.readTextFileSync(accounts));
    Deno.writeTextFileSync(
      accounts,
      JSON.stringify({ ...value, accounts: [] }) + "\n",
    );
    f.retire();
    const reopened = bootstrapContext(root, scope);
    assertEquals(reopened.bootstrap.status(), {
      setupRequired: false,
    });
    reopened.retire();
    Deno.writeTextFileSync(accounts, "corrupt");
    assertThrows(
      () => bootstrapContext(root, scope),
      IdentityStateError,
      "Invalid identity state; original bytes retained.",
    );
    assertEquals(Deno.readTextFileSync(accounts), "corrupt");
  }));

Deno.test("identity bootstrap: absent journal does not admit a second root owner", () =>
  identityFixture((root, scope) => {
    const f = bootstrapContext(root, scope);
    const recovery = recoveryForRoot(root);
    scope.defer(() => recovery.close());
    assertThrows(
      () =>
        openIdentityTransaction(
          f.accounts,
          `${root}/vault`,
          f.lease,
          recovery.authority,
        ),
      IdentityTransactionUnavailable,
      "Identity publication requires recovery; no partial state is available.",
    );
    f.bootstrap.dispose();
    assertEquals(
      openIdentityTransaction(
        f.accounts,
        `${root}/vault`,
        f.lease,
        recovery.authority,
      ),
      undefined,
    );
  }));
