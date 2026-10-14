// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { readManifest } from "../server/plugins/manifest.ts";
import { assertFsCode, auxiliaryFixture } from "./helpers/auxiliary_fixture.ts";
import type { FsStat } from "../server/plugins/contracts.ts";

Deno.test("backup canonical root: settings-root grant creates selected root without granting its ancestors or sibling", async () => {
  const reference = { settings: { page: "preferences", key: "base" } };
  const b = await auxiliaryFixture({
    read: ["vault", reference],
    write: ["vault", reference],
  });
  const root = `${b.root}/external`;
  try {
    const initial = await b.settings();
    await b.data.forPlugin(b.id).savePage(
      b.page,
      { base: root, count: 2 },
      initial.revision,
      initial.sourceKey,
    );
    const current = await b.settings();
    await assertFsCode(
      b.call("realPath", root, { sourceKey: current.sourceKey }),
      "fs_not_found",
    );
    await assertFsCode(
      b.call("mkdir", `${b.root}/parent/missing`, {
        recursive: true,
        sourceKey: current.sourceKey,
      }),
      "fs_denied",
    );
    const created = (await b.call("mkdir", root, {
      expect: { kind: "absent" },
      sourceKey: current.sourceKey,
    })).value as FsStat;
    assertEquals(created.kind, "directory");
    assertEquals(
      await b.call("realPath", root, {
        sourceKey: current.sourceKey,
        expect: { kind: "exact", token: created.token },
      }),
      { value: root },
    );
    await assertFsCode(
      b.call("stat", `${b.root}/sibling`, { sourceKey: current.sourceKey }),
      "fs_denied",
    );
    await assertFsCode(
      b.call("realPath", b.root, { sourceKey: current.sourceKey }),
      "fs_denied",
    );
    await b.call("writeFile", `${root}/bytes`, new Uint8Array([3]), {
      expect: { kind: "absent" },
      sourceKey: current.sourceKey,
    });
    assertEquals(await Deno.readFile(`${root}/bytes`), new Uint8Array([3]));
    await b.data.forPlugin(b.id).savePage(
      b.page,
      { base: "", count: 2 },
      current.revision,
      current.sourceKey,
    );
    const empty = await b.settings();
    await assertFsCode(
      b.call("stat", root, { sourceKey: empty.sourceKey }),
      "fs_denied",
    );
    assertEquals(await Deno.readFile(`${root}/bytes`), new Uint8Array([3]));
  } finally {
    await b.close();
  }
});

Deno.test("backup FS: manifests reject foreign/extra/non-folder references without widening raw grants", async () => {
  const b = await auxiliaryFixture();
  const file = `${b.dir}/manifest.json`,
    raw = await Deno.readTextFile(file),
    manifest = JSON.parse(raw);
  try {
    for (
      const grant of [
        { settings: { page: "preferences", key: "count" } },
        { settings: { page: "foreign", key: "base" } },
        { settings: { page: "preferences", key: "base", pluginId: "foreign" } },
        { settings: { page: "preferences", key: "base" }, extra: true },
        "/",
      ]
    ) {
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          ...manifest,
          capabilities: {
            ...manifest.capabilities,
            filesystem: { read: [grant], write: [] },
          },
        }),
      );
      assertThrows(() => readManifest(b.dir));
    }
  } finally {
    await Deno.writeTextFile(file, raw);
    await b.close();
  }
});

Deno.test("backup canonical root: unrelated selected-root creation cannot invalidate an unchanged vault journal token", async () => {
  const reference = { settings: { page: "preferences", key: "base" } },
    b = await auxiliaryFixture({
      read: ["vault", reference],
      write: ["vault", reference],
    });
  const root = `${b.root}/new-base`;
  try {
    await b.data.forPlugin(b.id).savePage(b.page, { base: root, count: 2 }, 0);
    const settings = await b.settings(),
      options = { sourceKey: settings.sourceKey };
    const publication =
      (await b.call("writeFile", "journal", new Uint8Array([1]), {
        ...options,
        expect: { kind: "absent" },
      })).value as { token: string };
    await b.call("mkdir", root, { ...options, expect: { kind: "absent" } });
    const acknowledged = await b.call(
      "writeFile",
      "journal",
      new Uint8Array([2]),
      { ...options, expect: { kind: "exact", token: publication.token } },
    );
    assertEquals(
      acknowledged.error,
      undefined,
      "only bindings authorizing/addressing this target belong to its conditional token",
    );
    assertEquals(
      await Deno.readFile(`${b.vault}/journal`),
      new Uint8Array([2]),
    );
  } finally {
    await b.close();
  }
});

for (const kind of ["literal", "settings"] as const) {
  Deno.test(`backup canonical root: ${kind} root retains absent symlink directory requirements`, async () => {
    const reference = { settings: { page: "preferences", key: "base" } };
    const grant = kind === "literal" ? "directory-alias" : reference;
    const b = await auxiliaryFixture({ read: [grant], write: [grant] });
    const root = `${b.root}/missing-root`;
    try {
      await Deno.symlink(`${root}/`, `${b.vault}/directory-alias`);
      if (kind === "settings") {
        const current = await b.settings();
        await b.data.forPlugin(b.id).savePage(
          b.page,
          { base: "directory-alias", count: 2 },
          current.revision,
          current.sourceKey,
        );
      }
      const current = await b.settings();
      await assertFsCode(
        b.call("writeFile", root, new Uint8Array([1]), {
          sourceKey: current.sourceKey,
          expect: { kind: "absent" },
        }),
        "fs_invalid_path",
      );
      assertEquals(
        await b.call("stat", root, { sourceKey: current.sourceKey }),
        { value: null },
      );
      const directory = (await b.call("mkdir", root, {
        sourceKey: current.sourceKey,
        expect: { kind: "absent" },
      })).value as FsStat;
      assertEquals(directory.kind, "directory");
      await b.call("writeFile", `${root}/child.bin`, new Uint8Array([3]), {
        sourceKey: current.sourceKey,
        expect: { kind: "absent" },
      });
      assertEquals(
        await Deno.readFile(`${root}/child.bin`),
        new Uint8Array([3]),
      );
    } finally {
      await b.close();
    }
  });
}
