// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { admitLayout, fixtureLayout } from "./helpers/fixture_layout.ts";
import {
  type IdentityFixturePayload,
  identityFixturePayload,
  prepareIdentityBoot,
} from "./helpers/identity_fixture.ts";
import { resetFixturePassword } from "./helpers/account_preparation.ts";
import { ACCOUNT_A, UPDATE, VAULT_A, VAULT_B } from "./helpers/identity.ts";
import { GUEST, InstanceSessions } from "../server/auth/sessions.ts";
import { AuthenticationError } from "../server/auth/account_credentials.ts";
import { singleVaultIdentity } from "../server/config/single_vault.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { IdentityStateError } from "../server/auth/records.ts";

function payload(
  everybody: "edit" | "view" | "none" = "edit",
): IdentityFixturePayload {
  return {
    vaultId: VAULT_A,
    people: [{ login: "alice", password: "password" }, {
      login: "bob",
      password: "temporary",
      temporary: true,
    }],
    everybody,
    grants: { alice: "admin", bob: "none" },
  };
}
for (const everybody of ["edit", "view", "none"] as const) {
  Deno.test(`account fixture preparation: scoped ${everybody} policy and actual sign-in`, () =>
    fixtureScope(async (scope) => {
      const layout = await fixtureLayout(scope, {});
      const prepared = await prepareIdentityBoot(
        layout,
        scope,
        payload(everybody),
      );
      const sessions = new InstanceSessions(
        prepared.accounts,
        prepared.signing,
        { expirySeconds: 1000 },
      );
      const alice = await signIn(sessions, {
        username: "alice",
        password: "password",
      });
      const bob = await signIn(sessions, {
        username: "bob",
        password: "temporary",
      });
      assertEquals([
        prepared.acl.effectiveLevel(alice.principal),
        prepared.acl.effectiveLevel(bob.principal),
        prepared.acl.effectiveLevel(GUEST),
        alice.principal.passwordChangeRequired,
        bob.principal.passwordChangeRequired,
      ], ["admin", "none", everybody, false, true]);
      assertEquals(
        prepared.accounts.capture().value.accounts.map((a) => a.login),
        ["alice", "bob"],
      );
      assertEquals(
        singleVaultIdentity(prepared.paths, () => scope.assertCurrent()).id,
        VAULT_A,
      );
      assertThrows(
        () => Deno.statSync(`${prepared.paths.statePath}/config.json`),
        Deno.errors.NotFound,
        "No such file",
      );
    }));
}
Deno.test("account fixture preparation: payload copy and pending input are independent", () =>
  fixtureScope(async (scope) => {
    const layout = await fixtureLayout(scope, {}), input = payload("view");
    const copy = identityFixturePayload(input);
    assertEquals(copy, input);
    assertEquals(copy === input, false);
    const pending = prepareIdentityBoot(layout, scope, input);
    input.everybody = "edit";
    input.grants = { alice: "none" };
    const prepared = await pending;
    assertEquals(prepared.acl.capture().value.everybody, "view");
    assertEquals(prepared.acl.capture().value.grants, {
      [prepared.accounts.byLogin("alice")!.id]: "admin",
      [prepared.accounts.byLogin("bob")!.id]: "none",
    });
  }));
Deno.test("account fixture preparation: reopen preserves changed password and ACL bytes", () =>
  fixtureScope(async (scope) => {
    const layout = await fixtureLayout(scope, {}), input = payload();
    const record = await fixtureScope(async (borrower) => {
      const first = await prepareIdentityBoot(layout, borrower, input);
      assertStrictEquals(
        await prepareIdentityBoot(layout, borrower, input),
        first,
      );
      await assertRejects(
        () =>
          fixtureScope((other) => prepareIdentityBoot(layout, other, input)),
        Error,
        "already borrowed",
      );
      const alice = first.accounts.byLogin("alice")!;
      await resetFixturePassword(
        first.accounts,
        alice.id,
        "private-password",
        UPDATE,
      );
      first.acl.save(
        { everybody: "none", grants: { [alice.id]: "view" } },
        first.acl.capture(),
        { updateId: UPDATE, actorId: alice.id },
      );
      return {
        alice,
        accounts: first.accounts,
        filenames: [
          first.accounts.root + "/accounts.json",
          first.accounts.root + "/sessions.json",
          first.paths.statePath + "/access.json",
        ],
      };
    });
    const { alice, filenames } = record;
    const before = filenames.map((name) => Deno.readTextFileSync(name));
    const second = await prepareIdentityBoot(layout, scope, input);
    assertEquals(second.accounts === record.accounts, false);
    assertEquals(filenames.map((name) => Deno.readTextFileSync(name)), before);
    assertEquals(second.accounts.byLogin("alice")!.id, alice.id);
    const sessions = new InstanceSessions(second.accounts, second.signing, {
      expirySeconds: 1000,
    });
    await assertRejects(
      () => signIn(sessions, { username: "alice", password: "password" }),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    const signed = await signIn(sessions, {
      username: "alice",
      password: "private-password",
    });
    assertEquals([
      signed.principal.passwordChangeRequired,
      second.acl.effectiveLevel(signed.principal),
      second.acl.effectiveLevel(GUEST),
    ], [true, "view", "none"]);
  }));
for (const missing of ["accounts", "signing", "access"] as const) {
  Deno.test(`account fixture preparation: missing ${missing} refuses instead of reseeding`, () =>
    fixtureScope(async (scope) => {
      const layout = await fixtureLayout(scope, {});
      const files = await fixtureScope(async (borrower) => {
        const first = await prepareIdentityBoot(layout, borrower, payload());
        return {
          accounts: `${first.accounts.root}/accounts.json`,
          signing: `${first.accounts.root}/sessions.json`,
          access: `${first.paths.statePath}/access.json`,
        };
      });
      const remaining = Object.entries(files).filter(([key]) => key !== missing)
        .map(([, name]) => name);
      const before = remaining.map((name) => Deno.readTextFileSync(name));
      Deno.removeSync(files[missing]);
      await assertRejects(
        () => prepareIdentityBoot(layout, scope, payload()),
        Error,
        "Incomplete identity fixture.",
      );
      assertEquals(
        remaining.map((name) => Deno.readTextFileSync(name)),
        before,
      );
      assertThrows(
        () => Deno.statSync(files[missing]),
        Deno.errors.NotFound,
        "No such file",
      );
    }));
}
for (const invalid of ["authenticator", "grant"] as const) {
  Deno.test(`account fixture preparation: invalid ${invalid} leaves the layout available for a corrected seed`, () =>
    fixtureScope(async (scope) => {
      const layout = await fixtureLayout(scope, {});
      const valid = payload();
      const malformed = invalid === "authenticator"
        ? {
          ...valid,
          people: [{
            login: "alice",
            password: "password",
            totpKeyEncoding: "base32",
          }, valid.people[1]],
        }
        : { ...valid, grants: { alice: "owner" } };
      await assertRejects(
        () =>
          prepareIdentityBoot(
            layout,
            scope,
            malformed as IdentityFixturePayload,
          ),
        IdentityStateError,
      );
      const prepared = await prepareIdentityBoot(layout, scope, valid);
      const id = prepared.accounts.byLogin("alice")!.id;
      assertEquals(prepared.acl.capture().value.grants[id], "admin");
    }));
}
Deno.test("account fixture preparation: failure releases owned layout roots and keeps original error", async () => {
  let root = "";
  const error = await assertRejects(
    () =>
      fixtureScope(async (scope) => {
        const layout = await fixtureLayout(scope, {});
        root = layout.instance;
        await prepareIdentityBoot(layout, scope, {
          ...payload(),
          grants: { missing: "admin" },
        });
      }),
    Error,
    "Fixture grant requires an explicit person.",
  );
  assertEquals(error.message, "Fixture grant requires an explicit person.");
  assertEquals(root.length > 0, true);
  assertThrows(() => Deno.statSync(root), Deno.errors.NotFound, "No such file");
});
Deno.test("account fixture preparation: independent layouts retain distinct IDs and policy", () =>
  fixtureScope(async (scope) => {
    const a = await fixtureLayout(scope, {}),
      b = await fixtureLayout(scope, {});
    const first = await prepareIdentityBoot(a, scope, payload("edit"));
    const second = await prepareIdentityBoot(b, scope, {
      ...payload("view"),
      vaultId: VAULT_B,
    });
    assertEquals([
      first.acl.vaultId,
      second.acl.vaultId,
      first.acl.capture().value.everybody,
      second.acl.capture().value.everybody,
    ], [VAULT_A, VAULT_B, "edit", "view"]);
    assertEquals(first.accounts.root === second.accounts.root, false);
    assertEquals(
      first.accounts.byLogin("alice")!.id ===
        second.accounts.byLogin("alice")!.id,
      false,
    );
  }));
Deno.test("account fixture preparation: retired layout rejects before any data write", () =>
  fixtureScope(async (borrower) => {
    let layout!: Awaited<ReturnType<typeof fixtureLayout>>;
    await fixtureScope(async (owner) => {
      layout = await fixtureLayout(owner, {});
    });
    const admission = await assertRejects(
      () => admitLayout(layout, borrower, () => ACCOUNT_A),
      Error,
      "retired",
    );
    const preparation = await assertRejects(
      () => prepareIdentityBoot(layout, borrower, payload()),
      Error,
      "retired",
    );
    assertStrictEquals(admission.constructor, preparation.constructor);
    assertThrows(
      () => Deno.statSync(layout.instance),
      Deno.errors.NotFound,
      "No such file",
    );
  }));

Deno.test("account fixture preparation: marked and historical authenticator bytes survive reopen", () =>
  fixtureScope(async (scope) => {
    const layout = await fixtureLayout(scope, {});
    const input = payload("none");
    input.people = [
      {
        login: "alice",
        password: "password",
        totpKey: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        totpKeyEncoding: "base32",
      },
      { login: "bob", password: "password", totpKey: "historical-raw-key" },
    ];
    const filename = await fixtureScope(async (borrower) => {
      const first = await prepareIdentityBoot(layout, borrower, input);
      return `${first.accounts.root}/accounts.json`;
    });
    const bytes = Deno.readTextFileSync(filename);
    const accounts = JSON.parse(bytes).accounts;
    assertEquals(
      accounts.map((a: Record<string, unknown>) => ({
        login: a.login,
        key: a.totpKey,
        encoding: a.totpKeyEncoding ?? null,
        floor: a.lastTotpStep,
      })),
      [
        {
          login: "alice",
          key: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
          encoding: "base32",
          floor: null,
        },
        {
          login: "bob",
          key: "historical-raw-key",
          encoding: null,
          floor: null,
        },
      ],
    );
    await prepareIdentityBoot(layout, scope, payload("edit"));
    assertEquals(Deno.readTextFileSync(filename), bytes);
  }));
