// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { AccountRepository } from "../server/auth/accounts.ts";
import { decodeTotpKey } from "../server/auth/credentials.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { identityAccount, identityFixture } from "./helpers/identity.ts";
import { createUuid } from "../shared/uuid.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

const KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

for (const raw of ["\ud800", "\udfff", "a\ud800b", "a\udfffb", "", null, 17]) {
  Deno.test(`TOTP boundary: rejects invalid raw key ${JSON.stringify(raw)}`, () => {
    assertThrows(() => decodeTotpKey(raw as string));
  });
}

for (const path of ["create", "change", "reload"] as const) {
  Deno.test(`TOTP boundary: ${path} cannot admit a surrogate alias`, () =>
    identityFixture((root) => {
      const repo = new AccountRepository(root);
      if (path === "create") {
        assertThrows(() => repo.create(identityAccount({ totpKey: "\ud800" })));
        assertEquals(repo.byLogin("alice"), null);
        return;
      }
      const account = repo.create(identityAccount({ totpKey: KEY }));
      repo.consumeTotp(account.id, 0, 100);
      const raw = Deno.readTextFileSync(`${root}/accounts.json`);
      if (path === "change") {
        assertThrows(() =>
          repo.changeCredentials(
            account.id,
            0,
            { totpKey: "\ud800" },
            createUuid(),
            undefined,
            99,
          )
        );
        assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), raw);
        assertEquals(repo.byId(account.id)?.lastTotpStep, 100);
      } else {
        const invalid = raw.replace(KEY, "\\ud800");
        assert(invalid !== raw);
        Deno.writeTextFileSync(`${root}/accounts.json`, invalid);
        assertThrows(() => new AccountRepository(root));
        assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), invalid);
      }
    }));
}

for (
  const changes of [
    {},
    { passwordHash: identityAccount().passwordHash },
    { passwordChangeRequired: true },
    { totpKey: undefined },
    { totpKey: KEY },
  ]
) {
  Deno.test(`TOTP floor: repository rejects a lower confirmed step with ${JSON.stringify(changes)}`, () =>
    identityFixture((root) => {
      const repo = new AccountRepository(root);
      const account = repo.create(
        identityAccount({ totpKey: KEY, lastTotpStep: 100 }),
      );
      const before = Deno.readTextFileSync(`${root}/accounts.json`);
      assertThrows(
        () =>
          repo.changeCredentials(
            account.id,
            0,
            changes,
            createUuid(),
            undefined,
            99,
          ),
        changes.totpKey === KEY ? StoredConfigConflict : IdentityStateError,
      );
      assertEquals(repo.byId(account.id)?.lastTotpStep, 100);
      assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), before);
      assertEquals(
        new AccountRepository(root).byId(account.id)?.lastTotpStep,
        100,
      );
      assertThrows(
        () => repo.consumeTotp(account.id, 0, 100),
        StoredConfigConflict,
      );
    }));
}

Deno.test("TOTP floor: confirmed steps require an explicit key; password-only changes preserve the floor", () =>
  identityFixture((root) => {
    const repo = new AccountRepository(root);
    const account = repo.create(
      identityAccount({ totpKey: KEY, lastTotpStep: 100 }),
    );
    for (const totpKey of [undefined, null]) {
      const before = Deno.readTextFileSync(`${root}/accounts.json`);
      assertThrows(() =>
        repo.changeCredentials(
          account.id,
          0,
          { totpKey },
          createUuid(),
          undefined,
          101,
        ), IdentityStateError);
      assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), before);
    }
    const passwordOnly = repo.changeCredentials(
      account.id,
      0,
      { passwordHash: identityAccount().passwordHash },
      createUuid(),
    );
    assertEquals(passwordOnly.lastTotpStep, 100);
    const next = repo.changeCredentials(
      account.id,
      1,
      { totpKey: KEY },
      createUuid(),
      undefined,
      101,
    );
    assertEquals(next.lastTotpStep, 101);
    const proof = repo.consumeTotp(account.id, 2, 102);
    const own = repo.changeCredentials(
      account.id,
      2,
      { totpKey: KEY },
      createUuid(),
      undefined,
      102,
      proof,
    );
    assertEquals(own.lastTotpStep, 102);
    assertEquals(
      repo.changeCredentials(
        account.id,
        3,
        { totpKey: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" },
        createUuid(),
        undefined,
        99,
      ).lastTotpStep,
      99,
    );
  }));

Deno.test("race settlement: account hashing races use an operation-owned milestone and finally drain", () => {
  const source = Deno.readTextFileSync(
    new URL("./identity_account_workflows_test.ts", import.meta.url),
  );
  const race = source.slice(
    source.indexOf("Deno.test(`own account: ${cause} during hash preparation"),
    source.indexOf('Deno.test("own account: no target-account field'),
  );
  assert(
    race.includes("workMilestone("),
    "hash milestone must observe the operation's rejection",
  );
  assert(
    !race.includes("await entered.promise"),
    "never await an orphaned milestone",
  );
  assert(race.indexOf("try {") < race.indexOf("workMilestone("));
  const cleanup = race.slice(race.indexOf("finally {"));
  assert(
    cleanup.includes("held.resolve("),
    "finally must release the held hash",
  );
  assert(
    cleanup.includes("await changing.catch("),
    "finally must drain the operation",
  );
});

Deno.test("race settlement: early operation rejection settles the milestone and cleanup", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const failure = new Error("rejected before hashing");
  const changing = Promise.reject(failure);
  changing.catch(() => {});
  let cleaned = false;
  try {
    const actual = await assertRejects(() =>
      workMilestone(changing, entered.promise, "early rejection")
    );
    assertEquals(actual, failure);
  } finally {
    release.resolve();
    await changing.catch(() => {});
    cleaned = true;
  }
  assert(cleaned);
});
