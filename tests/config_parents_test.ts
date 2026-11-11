// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  BoundFileStore,
  StoredConfigConflict,
} from "../server/config/file_store.ts";
import { VaultConfigStore } from "../server/config/vault.ts";
function fixture(run: (root: string) => void) {
  const root = Deno.makeTempDirSync({ prefix: "config-parents-" });
  try {
    run(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}
Deno.test("config parents: preparation creates only absent parents, leaves config absent and permits first save", () =>
  fixture((root) => {
    const file = `${root}/metadata/globnotes/config.toml`,
      store = new VaultConfigStore("globnotes", file);
    const values = store.settings;
    store.prepareParents();
    assertEquals(store.settings, values);
    assert(Deno.statSync(`${root}/metadata/globnotes`).isDirectory);
    assertFalse([...Deno.readDirSync(`${root}/metadata/globnotes`)].length > 0);
    assertEquals(store.capture().persistence.raw, null);
    store.save({ brand: { name: "First" } });
    assertEquals(
      new VaultConfigStore("globnotes", file).settings.brand.name,
      "First",
    );
  }));
Deno.test("config parents: pre-existing parents retain identities and bytes without mkdir", () =>
  fixture((root) => {
    const file = `${root}/config.toml`;
    Deno.writeTextFileSync(file, '[brand]\nname="keep"');
    const store = new BoundFileStore(file),
      before = store.capture(),
      mkdir = Deno.mkdirSync;
    try {
      Deno.mkdirSync = (() => {
        throw Error("must not create existing parents");
      }) as typeof mkdir;
      assertEquals(store.prepareParents(before), before);
    } finally {
      Deno.mkdirSync = mkdir;
    }
  }));
for (
  const kind of [
    "competing-creation",
    "retarget",
    "same-bytes-replacement",
    "late-retarget",
  ]
) {
  Deno.test(`config parents: ${kind} conflicts without adopting interference`, () =>
    fixture((root) => {
      Deno.mkdirSync(`${root}/owned`);
      Deno.mkdirSync(`${root}/other`);
      const file = kind === "competing-creation"
        ? `${root}/absent/config.toml`
        : `${root}/owned/config.toml`;
      if (kind !== "competing-creation") {
        Deno.writeTextFileSync(file, '[brand]\nname="keep"');
      }
      const store = new BoundFileStore(file),
        before = store.capture(),
        mkdir = Deno.mkdirSync;
      try {
        if (kind === "competing-creation") {
          Deno.mkdirSync = ((p, options) => {
            mkdir(p, options);
            throw new Deno.errors.AlreadyExists("competing creator");
          }) as typeof mkdir;
        }
        if (kind === "retarget") {
          Deno.renameSync(`${root}/owned`, `${root}/original`);
          Deno.symlinkSync("other", `${root}/owned`);
        }
        if (kind === "same-bytes-replacement") {
          Deno.writeTextFileSync(`${root}/replacement`, before.raw!);
          Deno.renameSync(`${root}/replacement`, file);
        }
        if (kind === "late-retarget") {
          const capture = store.capture.bind(store);
          let calls = 0;
          store.capture = () => {
            if (++calls === 2) {
              Deno.renameSync(`${root}/owned`, `${root}/original`);
              Deno.symlinkSync("other", `${root}/owned`);
            }
            return capture();
          };
        }
        assertThrows(() => store.prepareParents(before), StoredConfigConflict);
        if (kind === "retarget" || kind === "late-retarget") {
          assertEquals(
            Deno.readTextFileSync(`${root}/original/config.toml`),
            before.raw,
          );
        }
      } finally {
        Deno.mkdirSync = mkdir;
      }
    }));
}
