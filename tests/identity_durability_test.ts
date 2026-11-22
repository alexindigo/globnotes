// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { identityFixture } from "./helpers/identity.ts";
import { transactionContext } from "./helpers/identity_transaction.ts";
import { observeDurability } from "./helpers/durability.ts";
import { IdentityTransactionUnavailable } from "../server/auth/transaction.ts";
import { recoveryForRoot } from "./helpers/account_preparation.ts";

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
    const staged = await f.stage();
    observeDurability((events) => {
      assertEquals(
        f.transaction.commit(staged.meta, staged.parts, f.lease).state,
        "committed",
      );
      const publications = events.filter((e) =>
        e.kind === "link" || e.kind === "rename"
      );
      assertEquals(publications.map((e) => e.file), [
        `${root}/identity-transaction.json`,
        `${root}/identity-transaction.json`,
        `${root}/vault/access.json`,
        `${root}/accounts.json`,
      ]);
      // Complete directory confirmation suffix proves retirement is not an unsynced unlink.
      assertEquals(events.at(-1), { kind: "directory", file: root });
    });
  }));
