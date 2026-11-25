// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { identityFixture } from "./helpers/identity.ts";
import { transactionContext } from "./helpers/identity_transaction.ts";
import { observeDurability } from "./helpers/durability.ts";
import { IdentityTransactionUnavailable } from "../server/auth/transaction.ts";
import { recoveryForRoot } from "./helpers/account_preparation.ts";
import {
  BoundFileStore,
  StoredConfigDurabilityError,
} from "../server/config/file_store.ts";
import { PublicationSetUnavailable } from "../server/config/publication_outcome.ts";

const unavailable = new IdentityTransactionUnavailable().message;
const setUnavailable = new PublicationSetUnavailable().message;

function ordinaryTargets(root: string) {
  return [
    new BoundFileStore(`${root}/accounts.json`),
    new BoundFileStore(`${root}/vault/access.json`),
  ];
}

function assertReserved(targets: readonly BoundFileStore[], raw: string) {
  for (const target of targets) {
    assertThrows(
      () => target.replace(raw),
      PublicationSetUnavailable,
      setUnavailable,
    );
  }
}

for (const phase of ["prepared", "decided"] as const) {
  for (const lane of ["commit", "recovery"] as const) {
    Deno.test(`identity transaction durability: ${phase} ${lane} keeps both writes reserved through failed retirement`, () =>
      identityFixture(async (root, scope) => {
        const retirement = new Error("fixture retirement refused");
        const beforeDecision = new Error("fixture before decision");
        const seed = transactionContext(root, scope, (point) => {
          if (phase === "prepared" && point === "prepared") {
            throw beforeDecision;
          }
          if (point === "retiring") throw retirement;
        });
        const staged = await seed.stage();
        const recovery = recoveryForRoot(root);
        scope.defer(() => recovery.close());

        const first = assertThrows(
          () => seed.transaction.commit(staged.meta, staged.parts, seed.lease),
          IdentityTransactionUnavailable,
          unavailable,
        );
        if (phase === "prepared") {
          assertEquals((first.cause as AggregateError).errors, [
            beforeDecision,
            retirement,
          ]);
        } else assertStrictEquals(first.cause, retirement);

        const journal = new BoundFileStore(`${root}/identity-transaction.json`);
        const saved = journal.capture().raw;
        const value = JSON.parse(saved!);
        assertEquals(value.phase, phase);
        const targets = ordinaryTargets(root);
        const expected = phase === "prepared" ? [null, null] : [
          value.participants[1].after.raw,
          value.participants[0].after.raw,
        ];
        let failed = seed;
        if (lane === "recovery") {
          seed.retire();
          failed = transactionContext(root, scope, (point) => {
            if (point === "retiring") throw retirement;
          });
          assertStrictEquals(
            assertThrows(
              () => failed.transaction.recover(recovery.authority),
              IdentityTransactionUnavailable,
              unavailable,
            ).cause,
            retirement,
          );
        }
        assertThrows(
          failed.transaction.assertReady,
          IdentityTransactionUnavailable,
          unavailable,
        );
        const nextBytes = '{"ordinary":"write"}\n';
        assertReserved(targets, nextBytes);
        assertEquals(journal.capture().raw, saved);
        assertEquals(targets.map((target) => target.capture().raw), expected);

        failed.retire();
        const next = transactionContext(root, scope);
        next.transaction.recover(recovery.authority);
        next.transaction.assertReady();
        assertEquals(journal.capture().raw, null);
        assertEquals(targets.map((target) => target.capture().raw), expected);
        for (const target of targets) target.replace(nextBytes);
        assertEquals(targets.map((target) => target.capture().raw), [
          nextBytes,
          nextBytes,
        ]);
      }));
  }
  Deno.test(`identity transaction durability: ${phase} directory sync failure after unlink retains custody`, () =>
    identityFixture(async (root, scope) => {
      let denySync: (() => void) | undefined;
      const beforeDecision = new Error("fixture before decision");
      const f = transactionContext(root, scope, (point) => {
        if (phase === "prepared" && point === "prepared") throw beforeDecision;
        if (point === "retiring") denySync!();
      });
      const staged = await f.stage();
      const recovery = recoveryForRoot(root);
      scope.defer(() => recovery.close());
      const journal = `${root}/identity-transaction.json`;
      const targets = ordinaryTargets(root);
      const nextBytes = '{"ordinary":"write"}\n';
      observeDurability((events, failDirectory) => {
        denySync = () => failDirectory(root);
        const { cause } = assertThrows(
          () => f.transaction.commit(staged.meta, staged.parts, f.lease),
          IdentityTransactionUnavailable,
          unavailable,
        );
        const syncFailure = phase === "prepared"
          ? (cause as AggregateError).errors[1]
          : cause;
        assertEquals([
          syncFailure instanceof StoredConfigDurabilityError,
          syncFailure.cause.message,
          new BoundFileStore(journal).capture().raw,
        ], [true, "fixture directory fsync failure", null]);
        assertReserved(targets, nextBytes);
        assertThrows(
          () => transactionContext(root, scope),
          IdentityTransactionUnavailable,
          unavailable,
        );
        assertThrows(
          () => f.transaction.close(),
          IdentityTransactionUnavailable,
          unavailable,
        );

        const retryStart = events.length;
        f.transaction.recover(recovery.authority);
        assertEquals(events.slice(retryStart), [{
          kind: "directory",
          file: root,
        }]);
        f.transaction.assertReady();
      }, journal);
      f.transaction.close();
      const next = transactionContext(root, scope);
      next.transaction.assertReady();
      for (const target of targets) target.replace(nextBytes);
      assertEquals(targets.map((target) => target.capture().raw), [
        nextBytes,
        nextBytes,
      ]);
    }));
}

Deno.test("identity transaction durability: journal retirement failure keeps the installed pair fenced", () =>
  identityFixture(async (root, scope) => {
    const f = transactionContext(root, scope);
    const staged = await f.stage();
    const remove = Deno.removeSync;
    const journal = `${root}/identity-transaction.json`;
    try {
      Deno.removeSync = (path, options) => {
        if (path === journal) throw new Error("fixture journal retirement");
        return remove(path, options);
      };
      assertThrows(
        () => f.transaction.commit(staged.meta, staged.parts, f.lease),
        IdentityTransactionUnavailable,
        "Identity publication requires recovery; no partial state is available.",
      );
    } finally {
      Deno.removeSync = remove;
    }
    assertThrows(
      () => f.transaction.assertReady(),
      IdentityTransactionUnavailable,
      "Identity publication requires recovery; no partial state is available.",
    );
    assertEquals(JSON.parse(Deno.readTextFileSync(journal)).phase, "decided");
    const recovery = recoveryForRoot(root);
    scope.defer(() => recovery.close());
    f.retire();
    const next = transactionContext(root, scope);
    next.transaction.recover(recovery.authority);
    next.transaction.assertReady();
    assertEquals([
      next.accounts.byLogin("alice")?.id,
      next.acl.capture().value.grants,
    ], [staged.identity.id, { [staged.identity.id]: "admin" }]);
  }));

Deno.test("identity transaction durability: every published file is synced before exact journal removal", () =>
  identityFixture(async (root, scope) => {
    const f = transactionContext(root, scope);
    const stage = await f.prepareStage();
    const vault = `${root}/vault`,
      journal = `${root}/identity-transaction.json`;
    observeDurability((events) => {
      const staged = stage();
      const result = f.transaction.commit(staged.meta, staged.parts, f.lease);
      assertEquals([result.state, result.warning], ["committed", null]);
      // Take only the identity of each random candidate from the native trace;
      // the expected effect order, kind and destination come from the fixture.
      const [prepared, decided, access, accounts] = events.filter((e) =>
        e.kind === "link" || e.kind === "rename"
      ).map((e) => e.source!);
      assertEquals(events, [
        { kind: "directory", file: root },
        { kind: "directory", file: vault },
        { kind: "directory", file: root },
        { kind: "file", file: access },
        { kind: "directory", file: vault },
        { kind: "directory", file: root },
        { kind: "directory", file: root },
        { kind: "directory", file: root },
        { kind: "file", file: accounts },
        { kind: "directory", file: root },
        { kind: "directory", file: root },
        { kind: "directory", file: root },
        { kind: "file", file: prepared },
        { kind: "link", file: journal, source: prepared },
        { kind: "directory", file: root },
        { kind: "directory", file: root },
        { kind: "directory", file: root },
        { kind: "file", file: decided },
        { kind: "rename", file: journal, source: decided },
        { kind: "directory", file: root },
        { kind: "link", file: `${vault}/access.json`, source: access },
        { kind: "directory", file: vault },
        { kind: "directory", file: root },
        { kind: "link", file: `${root}/accounts.json`, source: accounts },
        { kind: "directory", file: root },
        { kind: "unlink", file: journal },
        { kind: "directory", file: root },
      ]);
    }, journal);
  }));
