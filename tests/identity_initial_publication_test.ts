// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { identityFixture } from "./helpers/identity.ts";
import { transactionContext } from "./helpers/identity_transaction.ts";
import { PublicationSetUnavailable } from "../server/config/publication_outcome.ts";

for (const role of ["accounts", "access"] as const) {
  Deno.test(`identity initial publication: a competing ${role} first file is never overwritten`, () =>
    identityFixture(async (root, scope) => {
      const f = transactionContext(root, scope);
      const staged = await f.stage();
      const file = role === "accounts"
        ? `${root}/accounts.json`
        : `${root}/vault/access.json`;
      Deno.writeTextFileSync(file, "foreign winner");
      assertThrows(
        () => f.transaction.commit(staged.meta, staged.parts, f.lease),
        Error,
        "Stored configuration changed before commit.",
      );
      assertEquals(Deno.readTextFileSync(file), "foreign winner");
      assertEquals(
        [...Deno.readDirSync(root)].map((e) => e.name).sort(),
        role === "accounts" ? ["accounts.json", "vault"] : ["vault"],
      );
      assertEquals(
        [...Deno.readDirSync(`${root}/vault`)].map((e) => e.name),
        role === "access" ? ["access.json"] : [],
      );
    }));
}

Deno.test("identity initial publication: read and write consumers cannot observe the installed half", () =>
  identityFixture(async (root, scope) => {
    const f = transactionContext(root, scope);
    const staged = await f.stage();
    assertThrows(
      () => f.accounts.byLogin("alice"),
      PublicationSetUnavailable,
      "Publication set is unavailable; settlement or recovery is required.",
    );
    assertThrows(
      () => f.acl.effectiveLevel({ kind: "guest" }),
      PublicationSetUnavailable,
      "Publication set is unavailable; settlement or recovery is required.",
    );
    assertThrows(
      () => f.accounts.prepareParents(),
      PublicationSetUnavailable,
      "Publication set is unavailable; settlement or recovery is required.",
    );
    assertEquals(
      f.transaction.commit(staged.meta, staged.parts, f.lease).state,
      "committed",
    );
    assertEquals(f.accounts.byLogin("alice"), staged.identity);
  }));
