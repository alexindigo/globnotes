// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { BoundFileStore } from "../server/config/file_store.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import {
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  UPDATE,
} from "./helpers/identity.ts";

import { observeDurability as observe } from "./helpers/durability.ts";

for (const existing of [false, true]) {
  Deno.test(`bound durability: file sync precedes ${existing ? "rename" : "link"}, directory sync follows publication`, () =>
    identityFixture((root) => {
      const filename = `${root}/state/nested/config.json`;
      if (existing) {
        Deno.mkdirSync(`${root}/state/nested`, { recursive: true });
        Deno.writeTextFileSync(filename, "before");
      }
      const store = new BoundFileStore(filename);
      observe((events) => {
        store.replace("after");
        const published = events.findIndex((e) =>
          e.kind === (existing ? "rename" : "link") && e.file === filename
        );
        assert(published >= 0);
        assert(events.some((e, i) => e.kind === "file" && i < published));
        assert(
          events.some((e, i) =>
            e.kind === "directory" && e.file === `${root}/state/nested` &&
            i > published
          ),
          JSON.stringify(events),
        );
        if (!existing) {
          const parents = events.slice(0, published).filter((e) =>
            e.kind === "directory"
          ).map((e) => e.file);
          assertEquals(parents, [
            `${root}/state/nested`,
            `${root}/state`,
            root,
          ]);
          for (
            const [child, parent] of [[`${root}/state`, root], [
              `${root}/state/nested`,
              `${root}/state`,
            ]]
          ) {
            const creation = events.findIndex((e) =>
              e.kind === "mkdir" && e.file === child
            );
            assert(
              events.some((e, i) =>
                e.kind === "directory" && e.file === parent && i > creation &&
                i < published
              ),
            );
          }
        }
        console.log(JSON.stringify({ durabilityOrder: events }));
      });
      assertEquals(Deno.readTextFileSync(filename), "after");
    }));
}

for (const existing of [false, true]) {
  Deno.test(`accounts durability failure: ${existing ? "rename" : "link"} keeps committed snapshot and next mutation`, () =>
    identityFixture((root) => {
      const repo = new AccountRepository(root);
      if (existing) repo.create(identityAccount());
      observe((_events, deny) => {
        deny(root);
        const error = assertThrows(() => {
          if (existing) {
            repo.changeCredentials(identityAccount().id, 0, {}, UPDATE);
          } else repo.create(identityAccount());
        });
        assert(error instanceof Error);
        assert(error.message.includes("durability"), error.message);
      });
      const file = new BoundFileStore(`${root}/accounts.json`);
      assertEquals(repo.capture().persistence, file.capture());
      assertEquals(
        repo.capture().value,
        JSON.parse(Deno.readTextFileSync(file.filename)),
      );
      assertEquals(repo.initialized, true);
      repo.create(identityAccount({ id: ACCOUNT_B, login: "bob" }));
      assertEquals(new AccountRepository(root).byId(ACCOUNT_B)?.login, "bob");
    }));
}
