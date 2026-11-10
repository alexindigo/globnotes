// SPDX-License-Identifier: LGPL-3.0-only
import { parse } from "@std/toml";
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  BoundFileStore,
  StoredConfigConflict,
} from "../server/config/file_store.ts";
import { ConfigError, loadInstanceConfig } from "../server/config/loader.ts";
import { ConfigWriteError, VaultConfigStore } from "../server/config/vault.ts";

function fixture(run: (root: string, file: string) => void): void {
  const root = Deno.makeTempDirSync({ prefix: "vault-config-" });
  try {
    run(root, `${root}/state/config.toml`);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}
function seed(
  file: string,
  text = '[brand]\nname="Original"\n[quickaccess]\nlimit=9\n',
) {
  Deno.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  Deno.writeTextFileSync(file, text);
}

Deno.test("vault config: full deployment environment is scoped once for independent vault stores", () =>
  fixture((root, file) => {
    const env = {
      GLOBNOTES__SERVER_HOST: "globnotes.test",
      GLOBNOTES_METADATA_PATH: `${root}/metadata`,
      GLOBNOTES_FAMILY_PATH: `${root}/family`,
      GLOBNOTES_FAMILY_ADMIN: "Family admin",
      GLOBNOTES_FAMILY_BRAND_NAME: "Family pin",
      GLOBNOTES_WORK_PATH: `${root}/work`,
      GLOBNOTES_WORK_BRAND_NAME: "Work pin",
      GLOBNOTES_WORK_QUICKACCESS_LIMIT: "7",
      UNRELATED: "not configuration",
    };
    const loaded = loadInstanceConfig({
      env,
      overlayPath: null,
      vaults: {
        family: { path: `${root}/family`, overlayPath: null },
        work: { path: `${root}/work`, overlayPath: null },
      },
    });
    const family = new VaultConfigStore("family", file, { env }),
      work = new VaultConfigStore("work", `${root}/work.toml`, { env });
    assertEquals(family.settings, loaded.vaults.family.config);
    assertEquals(work.settings, loaded.vaults.work.config);
    assertEquals(
      family.provenance["brand.name"].source,
      "GLOBNOTES_FAMILY_BRAND_NAME",
    );
    assertEquals(
      work.provenance["brand.name"].source,
      "GLOBNOTES_WORK_BRAND_NAME",
    );
    assertThrows(
      () => family.save({ brand: { name: "Changed" } }),
      ConfigWriteError,
    );
    assertThrows(
      () => work.save({ brand: { name: "Changed" } }),
      ConfigWriteError,
    );
    // The constructor owns an immutable selection, not a live deployment map.
    env.GLOBNOTES_FAMILY_BRAND_NAME = "Later mutation";
    env.GLOBNOTES_WORK_BRAND_NAME = "Later mutation";
    family.save({ brand: { accent: "#123456" } });
    work.save({ brand: { accent: "#abcdef" } });
    assertEquals(family.settings.brand.name, "Family pin");
    assertEquals(work.settings.brand.name, "Work pin");
    assertEquals(work.settings.quickaccess.limit, 7);
    assertEquals(parse(Deno.readTextFileSync(file)), {
      brand: { accent: "#123456" },
    });
    assertEquals(parse(Deno.readTextFileSync(`${root}/work.toml`)), {
      brand: { accent: "#abcdef" },
    });
  }));

for (
  const variable of [
    "GLOBNOTES_FAMILY_BRAND_NMAE",
    "GLOBNOTES_FAMILY_BRANDNAME",
  ]
) {
  Deno.test(`vault config: whole-environment loader still rejects ${variable}`, () =>
    fixture((root) => {
      const error = assertThrows(() =>
        loadInstanceConfig({
          env: {
            GLOBNOTES__SERVER_HOST: "globnotes.test",
            GLOBNOTES_FAMILY_BRAND_NAME: "Family pin",
            GLOBNOTES_WORK_BRAND_NAME: "Work pin",
            [variable]: "WITHHELD",
          },
          overlayPath: null,
          vaults: {
            family: { path: `${root}/family`, overlayPath: null },
            work: { path: `${root}/work`, overlayPath: null },
          },
        }), ConfigError);
      assert(error.message.includes(variable));
      assert(error.message.includes("unknown key or section"));
      assertFalse(error.message.includes("WITHHELD"));
    }));
}

for (
  const boundary of ["capture-failure", "external-edit", "cleanup-failure"]
) {
  Deno.test(`vault config: committed snapshot survives post-rename ${boundary} and governs the following save`, () =>
    fixture((_root, file) => {
      seed(file);
      const store = new VaultConfigStore("family", file),
        before = store.capture(),
        rename = Deno.renameSync,
        remove = Deno.removeSync,
        capture = BoundFileStore.prototype.capture;
      let written = "";
      try {
        Deno.renameSync = ((from, to) => {
          if (String(to) === file) written = Deno.readTextFileSync(from);
          rename(from, to);
          if (String(to) !== file) return;
          if (boundary === "capture-failure") {
            BoundFileStore.prototype.capture = () => {
              throw new Deno.errors.PermissionDenied("post-rename capture");
            };
          }
          if (boundary === "external-edit") {
            Deno.writeTextFileSync(file, '[brand]\nname="External"\n');
          }
          if (boundary === "cleanup-failure") {
            Deno.removeSync = ((name, options) => {
              if (String(name).includes("/.config-")) {
                throw new Deno.errors.PermissionDenied("post-rename cleanup");
              }
              remove(name, options);
            }) as typeof remove;
          }
        }) as typeof rename;
        if (boundary === "cleanup-failure") {
          assertThrows(
            () => store.save({ brand: { name: "Committed" } }),
            Deno.errors.PermissionDenied,
            "post-rename cleanup",
          );
        } else {
          assertEquals(
            store.save({ brand: { name: "Committed" } }).brand.name,
            "Committed",
          );
        }
        assertEquals(store.settings.brand.name, "Committed");
        assert(store.capture() !== before);
        assertEquals(store.capture().persistence.raw, written);
        assert(store.capture().resolved.loaded.includes(file));
      } finally {
        Deno.renameSync = rename;
        Deno.removeSync = remove;
        BoundFileStore.prototype.capture = capture;
      }
      const committed = store.capture();
      if (boundary === "external-edit") {
        assertThrows(
          () => store.save({ brand: { name: "Must not overwrite" } }),
          StoredConfigConflict,
        );
        assertEquals(store.capture(), committed);
        assertEquals(
          new VaultConfigStore("family", file).settings.brand.name,
          "External",
        );
        // Restore bytes on the committed inode, then prove the binding is usable.
        Deno.writeTextFileSync(file, written);
      }
      store.save({ brand: { accent: "#123456" } });
      assertEquals(new VaultConfigStore("family", file).settings.brand, {
        name: "Committed",
        accent: "#123456",
      });
    }));
}

Deno.test("vault config: save clear and restart persist only saved leaves, not defaults or env", () =>
  fixture((root, file) => {
    seed(file);
    const env = { GLOBNOTES_FAMILY_QUICKACCESS_TITLE: "Deployment" };
    const store = new VaultConfigStore("family", file, { env });
    const original = store.capture();
    assert(Object.isFrozen(original.saved));
    assert(Object.isFrozen(store.settings.brand));
    assertEquals(store.provenance["quickaccess.title"].layer, "env");
    let guards = 0;
    store.save({ brand: { name: "", accent: "#112233" } }, original, () => {
      guards++;
    });
    assertEquals(guards, 2);
    assertEquals(store.settings.brand, { name: "", accent: "#112233" });
    assertEquals(parse(Deno.readTextFileSync(file)), {
      brand: { name: "", accent: "#112233" },
      quickaccess: { limit: 9 },
    });
    const restarted = new VaultConfigStore("family", file, { env });
    assertEquals(restarted.settings.brand.name, "");
    assertEquals(restarted.settings.quickaccess.title, "Deployment");
    assertFalse(Deno.readTextFileSync(file).includes("Deployment"));
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), ["state"]);
  }));

Deno.test("vault config: env-pinned same-value writes reject; unpinned sibling remains writable", () =>
  fixture((_root, file) => {
    const store = new VaultConfigStore("family", file, {
      env: { GLOBNOTES_FAMILY_BRAND_NAME: "Pinned" },
    });
    assertThrows(
      () => store.save({ brand: { name: "Pinned" } }),
      ConfigWriteError,
    );
    assertEquals(store.capture().persistence.raw, null);
    store.save({ brand: { accent: "#abcdef" } });
    assert(store.capture().resolved.loaded.includes(file));
    assertEquals(store.settings.brand.name, "Pinned");
    assertEquals(parse(Deno.readTextFileSync(file)), {
      brand: { accent: "#abcdef" },
    });
  }));

Deno.test("vault config: plugin deployment leaves retain their existing owner", () =>
  fixture((_root, file) => {
    seed(file, '[plugins]\nautoenable=false\nsettings="{}"\n');
    const store = new VaultConfigStore("family", file),
      before = Deno.readTextFileSync(file);
    assertThrows(
      () => store.save({ plugins: { autoenable: true } }),
      ConfigWriteError,
    );
    assertThrows(
      () => store.save({ plugins: { settings: "{}" } }),
      ConfigWriteError,
    );
    assertEquals(Deno.readTextFileSync(file), before);
    store.save({ brand: { name: "Other" } });
    assertEquals(store.settings.plugins, { autoenable: false, settings: "{}" });
  }));

Deno.test("vault config: stale application snapshot and external edits retain memory and bytes", () =>
  fixture((_root, file) => {
    seed(file);
    const store = new VaultConfigStore("family", file), old = store.capture();
    store.save({ brand: { name: "Committed" } });
    assertThrows(
      () => store.save({ brand: { name: "Stale" } }, old),
      StoredConfigConflict,
    );
    const current = store.capture();
    Deno.writeTextFileSync(file, '[brand]\nname="External"');
    assertThrows(
      () => store.save({ brand: { name: "Overwrite" } }),
      StoredConfigConflict,
    );
    assertEquals(store.capture(), current);
    assertEquals(store.settings.brand.name, "Committed");
    assertEquals(
      new VaultConfigStore("family", file).settings.brand.name,
      "External",
    );
  }));

Deno.test("vault config: guarded late edit rejects before any filesystem effect", () =>
  fixture((_root, file) => {
    seed(file);
    const store = new VaultConfigStore("family", file),
      snapshot = store.capture();
    let guards = 0;
    assertThrows(() =>
      store.save({ brand: { name: "Denied" } }, snapshot, () => {
        if (++guards === 2) throw Error("authority retired");
      })
    );
    assertEquals(store.capture(), snapshot);
    assertEquals(Deno.readTextFileSync(file), snapshot.persistence.raw);
  }));

for (
  const malformed of [
    '[unknown]\nkey="SECRET"',
    "[brand]\nname=SECRET",
    '[auth]\npassword="SECRET"',
  ]
) {
  Deno.test(`vault config: invalid file is not replaced (${malformed.slice(1, malformed.indexOf("]"))})`, () =>
    fixture((_root, file) => {
      seed(file, malformed);
      const error = assertThrows(
        () => new VaultConfigStore("family", file),
        ConfigError,
      );
      assertFalse(error.message.includes("SECRET"));
      assertEquals(Deno.readTextFileSync(file), malformed);
    }));
}

Deno.test("vault config: invalid patches are rejected without changing disk or snapshots", () =>
  fixture((_root, file) => {
    seed(file);
    const store = new VaultConfigStore("family", file),
      snapshot = store.capture();
    for (
      const patch of [
        { brand: { accent: "bad" } },
        { quickaccess: { limit: -1 } },
        { auth: { username: "SECRET" } },
        { brand: 3 },
      ]
    ) {
      assertThrows(() => store.save(patch as never), ConfigError);
      assertEquals(store.capture(), snapshot);
      assertEquals(Deno.readTextFileSync(file), snapshot.persistence.raw);
    }
  }));

for (const absolute of [true, false]) {
  Deno.test(`vault config: ${absolute ? "absolute" : "relative"} target links survive save and restart`, () =>
    fixture((root, file) => {
      const target = `${root}/deployment/vault.toml`;
      seed(target);
      Deno.mkdirSync(`${root}/state`);
      Deno.symlinkSync(absolute ? target : "../deployment/vault.toml", file);
      const ino = Deno.lstatSync(file).ino,
        store = new VaultConfigStore("family", file);
      store.save({ brand: { name: "Linked" } });
      assertEquals(Deno.lstatSync(file).ino, ino);
      assertEquals(
        new VaultConfigStore("family", file).settings.brand.name,
        "Linked",
      );
      assertEquals(
        (parse(Deno.readTextFileSync(target)).brand as Record<string, string>)
          .name,
        "Linked",
      );
    }));
}

for (const boundary of ["permissions", "rename", "retarget"]) {
  Deno.test(`vault config: ${boundary} failure retains original state`, () =>
    fixture((root, file) => {
      seed(file);
      const store = new VaultConfigStore("family", file),
        snapshot = store.capture(),
        rename = Deno.renameSync;
      try {
        if (boundary === "permissions") Deno.chmodSync(file, 0o444);
        if (boundary === "rename") {
          Deno.renameSync = (() => {
            throw new Deno.errors.PermissionDenied("fixture");
          }) as typeof rename;
        }
        if (boundary === "retarget") {
          const target = `${root}/external.toml`;
          Deno.writeTextFileSync(target, snapshot.persistence.raw!);
          Deno.removeSync(file);
          Deno.symlinkSync(target, file);
        }
        assertThrows(() => store.save({ brand: { name: "Must not publish" } }));
        assertEquals(store.capture(), snapshot);
        assertEquals(store.settings.brand.name, "Original");
        assertEquals(Deno.readTextFileSync(file), snapshot.persistence.raw);
      } finally {
        Deno.renameSync = rename;
        Deno.chmodSync(file, 0o600);
      }
    }));
}
