// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { BoundFileStore } from "../server/config/file_store.ts";
import { VaultConfigStore } from "../server/config/vault.ts";
import { identityFixture } from "./helpers/identity.ts";
import { observeDurability } from "./helpers/durability.ts";
import { bootServer } from "./helpers/boot.ts";

function store(file: string, root: string): BoundFileStore {
  return Reflect.construct(BoundFileStore, [file, root]);
}
Deno.test("owned root: unreadable traversable ancestors do not participate in saves", () =>
  identityFixture((root) => {
    root = Deno.realPathSync(root);
    const ancestor = `${root}/ancestor`,
      owned = `${ancestor}/state`,
      file = `${owned}/inside/config.json`;
    Deno.mkdirSync(owned, { recursive: true });
    Deno.chmodSync(ancestor, 0o111);
    try {
      assertThrows(
        () => Deno.openSync(ancestor, { read: true }),
        Deno.errors.PermissionDenied,
      );
      observeDurability((events) => {
        store(file, owned).replace("committed");
        const published = events.findIndex((e) =>
          e.kind === "link" && e.file === file
        );
        assert(published >= 0);
        assertEquals(
          events.slice(published + 1).filter((e) => e.kind === "directory").map(
            (e) => e.file,
          ),
          [`${owned}/inside`, owned],
        );
        assert(
          !events.some((e) => e.kind === "directory" && e.file === ancestor),
        );
      });
      assertEquals(Deno.readTextFileSync(file), "committed");
      store(file, owned).replace("replaced");
      assertEquals(Deno.readTextFileSync(file), "replaced");
    } finally {
      Deno.chmodSync(ancestor, 0o700);
    }
  }));

for (const boot of [false, true]) {
  Deno.test(`owned root: ${boot ? "server boot" : "preflight"} names an unreadable creation parent and its permission`, () =>
    identityFixture(async (root) => {
      root = Deno.realPathSync(root);
      const parent = `${root}/parent`, notes = `${root}/notes`;
      Deno.mkdirSync(parent);
      Deno.mkdirSync(notes);
      Deno.chmodSync(parent, 0o311);
      try {
        assertThrows(
          () => Deno.openSync(parent, { read: true }),
          Deno.errors.PermissionDenied,
        );
        const check = (error: Error) => {
          assert(error.message.includes(parent), error.message);
          assert(error.message.includes("read and search"), error.message);
        };
        if (boot) {
          check(
            await assertRejects(() =>
              bootServer({
                GLOBNOTES_GLOBNOTES_PATH: notes,
                GLOBNOTES__METADATA_PATH: `${parent}/metadata`,
              }), Error),
          );
        } else {check(assertThrows(() =>
            new VaultConfigStore("globnotes", `${parent}/state/config.toml`)
              .prepareParents(), Error));}
      } finally {
        Deno.chmodSync(parent, 0o700);
      }
      assertEquals([...Deno.readDirSync(parent)].length, 0);
    }));
}

Deno.test("owned root: startup preflight reports an unreadable existing root", () =>
  identityFixture((root) => {
    root = Deno.realPathSync(root);
    const owned = `${root}/state`;
    Deno.mkdirSync(owned);
    Deno.chmodSync(owned, 0o311);
    try {
      const error = assertThrows(
        () =>
          new VaultConfigStore("globnotes", `${owned}/config.toml`)
            .prepareParents(),
        Error,
      );
      assert(error.message.includes(owned), error.message);
      assert(error.message.includes("read and search"), error.message);
    } finally {
      Deno.chmodSync(owned, 0o700);
    }
  }));

for (const fresh of [false, true]) {
  Deno.test(`owned root: ${fresh ? "fresh" : "same"} store re-syncs all owned descendants on retry`, () =>
    identityFixture((root) => {
      root = Deno.realPathSync(root);
      const file = `${root}/inside/deep/config.json`;
      let bound = store(file, root);
      observeDurability((events, deny) => {
        deny(`${root}/inside`);
        assertThrows(() => bound.replace("committed"));
        assertEquals(bound.capture().raw, null);
        if (fresh) bound = store(file, root);
        const start = events.length;
        bound.replace("committed");
        const next = events.slice(start),
          pub = next.findIndex((e) => e.kind === "link");
        assert(pub >= 0);
        assertEquals(
          next.slice(pub + 1).filter((e) => e.kind === "directory").map((e) =>
            e.file
          ),
          [`${root}/inside/deep`, `${root}/inside`, root],
        );
      });
    }));
}
