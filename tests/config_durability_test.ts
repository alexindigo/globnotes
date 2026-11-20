// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname } from "@std/path";
import { StateRootError } from "../server/config/state_root.ts";
import {
  BoundFileStore,
  StoredConfigConflict,
} from "../server/config/file_store.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import {
  importFixtureAccount,
  preparationContext,
  recoveryForRoot,
} from "./helpers/account_preparation.ts";
import { logger } from "../server/logger.ts";
import {
  ACCOUNT_B,
  identityAccount,
  identityFixture as fixture,
  UPDATE,
} from "./helpers/identity.ts";
import { observeDurability as observe } from "./helpers/durability.ts";

// Deliberately noncanonical input: assertions must use the same real pathname
// that the bound store publishes, even when TMPDIR has an alias or dot segments.
function identityFixture(run: (root: string) => void | Promise<void>) {
  return fixture((root) =>
    run(Deno.realPathSync(`${root}/../${root.split("/").at(-1)}`))
  );
}

const chain = (directory: string, root = directory) => {
  const result = [directory];
  while (directory !== root) {
    result.push(directory = dirname(directory));
  }
  return result;
};
for (const existing of [false, true]) {
  Deno.test(`bound durability: exact candidate sync precedes ${existing ? "rename" : "link"}, full chain follows publication`, () =>
    identityFixture((fixtureRoot) => {
      const root = fixtureRoot;
      const filename = `${root}/state/nested/config.json`;
      if (existing) {
        Deno.mkdirSync(dirname(filename), { recursive: true });
        Deno.writeTextFileSync(filename, "before");
      }
      observe((events) => {
        new BoundFileStore(filename, root).replace("after");
        const published = events.findIndex((e) =>
          e.kind === (existing ? "rename" : "link") && e.file === filename
        );
        assert(published >= 0);
        assert(
          events.some((e, i) =>
            e.kind === "file" && e.file === events[published].source &&
            i < published
          ),
        );
        assertEquals(
          events.slice(published + 1).filter((e) => e.kind === "directory").map(
            (e) => e.file,
          ),
          chain(dirname(filename), root),
        );
      });
      assertEquals(Deno.readTextFileSync(filename), "after");
    }));
}

for (const fresh of [false, true]) {
  Deno.test(`bound durability: parent-sync failure is retryable with ${fresh ? "fresh" : "same"} repository`, () =>
    identityFixture(async (fixtureRoot) => {
      const root = fixtureRoot,
        directory = `${root}/state/identity`;
      let context = preparationContext(directory, {}), repo = context.accounts;
      const first = await repo.credentials.prepareInitialAccount(
        context.authority("initial"),
        context.request(),
      );
      observe((_events, deny) => {
        deny(directory);
        const error = assertThrows(
          () => repo.credentials.publishPreparedAccount(first.prepared),
          StateRootError,
        );
        assert(error.cause instanceof Deno.errors.PermissionDenied);
        assertEquals(error.cause.message, "fixture directory fsync failure");
        assertEquals(repo.initialized, false);
        assertEquals(
          new BoundFileStore(`${directory}/accounts.json`).capture().raw,
          null,
        );
      });
      if (fresh) {
        context.retire();
        repo.retireCredentials();
        context = preparationContext(directory, {});
        repo = context.accounts;
      }
      const second = await repo.credentials.prepareInitialAccount(
        context.authority("initial"),
        context.request(),
      );
      observe((events) => {
        repo.credentials.publishPreparedAccount(second.prepared);
        const next = events;
        const publication = next.findIndex((e) => e.kind === "link");
        assert(publication >= 0);
        assertEquals(
          next.slice(publication + 1).filter((e) => e.kind === "directory").map(
            (e) => e.file,
          ),
          chain(directory),
        );
      });
      assertEquals(repo.initialized, true);
      context.retire();
      repo.retireCredentials();
    }));
}

for (const existing of [false, true]) {
  Deno.test(`accounts durability warning: ${existing ? "rename" : "link"} publishes exact disk revision before warning and permits next mutation`, () =>
    identityFixture(async (fixtureRoot) => {
      const root = fixtureRoot,
        repo = new AccountRepository(root);
      const recovery = recoveryForRoot(root);
      if (existing) {
        repo.credentials.importAccount(recovery.authority, identityAccount());
      }
      let changing: Promise<unknown> | undefined;
      const original = logger.warning;
      const warnings: unknown[][] = [];
      try {
        observe((events, deny) => {
          logger.warning = (...args) => {
            const disk = JSON.parse(
              Deno.readTextFileSync(`${root}/accounts.json`),
            );
            assertEquals(disk.accounts[0].credentialRevision, existing ? 1 : 0);
            assertEquals(
              disk.accounts[0].credentialUpdateId,
              existing ? UPDATE : null,
            );
            assertEquals(
              disk.accounts[0].credentialRevision,
              repo.byId(identityAccount().id)?.credentialRevision,
            );
            assertEquals(
              disk.accounts[0].id,
              repo.byId(identityAccount().id)?.id,
            );
            warnings.push(args);
          };
          const rename = Deno.renameSync, link = Deno.linkSync;
          // Arm only after the commit point, not at preparation's fsync.
          Deno.renameSync = (from, to) => {
            rename(from, to);
            deny(root);
          };
          Deno.linkSync = (from, to) => {
            link(from, to);
            deny(root);
          };
          try {
            if (existing) {
              changing = repo.credentials.disableAuthenticator(
                recovery.authority,
                {
                  accountId: identityAccount().id,
                  credentialRevision: 0,
                  updateId: UPDATE,
                },
              );
              changing.catch(() => {});
            } else {repo.credentials.importAccount(
                recovery.authority,
                identityAccount(),
              );}
          } finally {
            Deno.renameSync = rename;
            Deno.linkSync = link;
          }
          assert(events.some((e) => e.kind === "directory" && e.file === root));
        });
      } finally {
        logger.warning = original;
        try {
          await changing;
        } finally {
          recovery.close();
        }
      }
      assertEquals(warnings.length, 1);
      assert(!JSON.stringify(warnings).includes(root));
      assert(
        !JSON.stringify(warnings).includes(identityAccount().passwordHash),
      );
      assertEquals(
        repo.capture().value.revision,
        JSON.parse(new BoundFileStore(`${root}/accounts.json`).capture().raw!)
          .revision,
      );
      repo.assertUnchanged();
      importFixtureAccount(
        repo,
        identityAccount({ id: ACCOUNT_B, login: "bob" }),
      );
      assertEquals(new AccountRepository(root).byId(ACCOUNT_B)?.login, "bob");
    }));
}

Deno.test("bound preparation retains only owned directory bindings after an unpublished failure", () =>
  identityFixture((fixtureRoot) => {
    const root = fixtureRoot,
      store = new BoundFileStore(`${root}/a/b/config.json`, root),
      before = store.capture();
    observe((_events, deny) => {
      deny(`${root}/a`);
      assertThrows(() => store.replace("after", before));
    });
    const moved = `${root}/a-original`;
    Deno.renameSync(`${root}/a`, moved);
    Deno.mkdirSync(`${root}/a/b`, { recursive: true });
    assertThrows(() => store.replace("after", before), StoredConfigConflict);
    assertEquals(store.capture().raw, null);
  }));
