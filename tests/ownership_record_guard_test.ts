// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  analyzeOwnership,
  inventoryErrors,
  repositorySources,
} from "./helpers/ownership_contract.ts";
import { LEGACY_OWNERSHIP } from "./helpers/ownership_legacy.ts";
import {
  RECORD_CHANNEL,
  RECORD_ENGINE_OWNERSHIP,
  RECORD_OWNERSHIP,
  RECORD_PILOT_FILES,
  RECORD_PILOT_OWNERSHIP,
  RECORD_PUBLICATION,
  registeredOwnership,
  RESOURCE_ENGINE_OWNERSHIP,
  SYNC_NATIVE,
  SYNC_PRELOAD,
} from "./helpers/ownership_rules.ts";
import { assertUnowned } from "./ownership_review_test.ts";
import { withPluginFixture } from "./helpers/plugin_fixture.ts";

const repositoryRoot = (moduleUrl: string | URL = import.meta.url) =>
  fromFileUrl(new URL("../", moduleUrl));

for (const file of RECORD_PILOT_FILES) {
  for (
    const member of [
      "remove",
      "removeSync",
      "truncate",
      "futureFilesystemOperation",
    ]
  ) {
    Deno.test(`P11 review: ${file} denies Deno.${member} by default`, () => {
      const text = `Deno.${member}("record");`;
      assertEquals(
        analyzeOwnership([{ file, text }], RECORD_PILOT_OWNERSHIP).map(
          ({ capability, source }) => ({ capability, source }),
        ),
        [{ capability: `Deno.${member}`, source: `Deno.${member}` }],
      );
    });
  }
}

Deno.test("P11 publication: portable module has no imports or ambient platform capabilities", async () => {
  const sources = await repositorySources(repositoryRoot());
  const source = sources.find((source) => source.file === RECORD_PUBLICATION)!;
  assert(source);
  assertEquals(source.imports, {});
  assertEquals(analyzeOwnership([source], RESOURCE_ENGINE_OWNERSHIP), []);
});

Deno.test("P11 review: encoded checkout roots reach actual record owners", async () => {
  await withPluginFixture(async (fixture) => {
    const link = join(fixture.root, "checkout space % #");
    await Deno.symlink(repositoryRoot(), link, { type: "dir" });
    const url = toFileUrl(join(link, "tests/ownership_record_guard_test.ts"));
    const root = repositoryRoot(url);
    assertEquals(root, link + "/");
    const sources = await repositorySources(root);
    const files = new Set(sources.map((source) => source.file));
    assert(files.has(RECORD_CHANNEL));
    assert(files.has(SYNC_NATIVE));
    assert(files.has(SYNC_PRELOAD));
    assertEquals(
      inventoryErrors(registeredOwnership(sources), LEGACY_OWNERSHIP, files),
      [],
    );
  });
});

for (const file of [SYNC_NATIVE, SYNC_PRELOAD]) {
  for (
    const [text, capability] of [
      ['; Deno.writeTextFile("control","{}");', "Deno.writeTextFile"],
      [
        'function local() {}; globalThis["Deno"].writeFileSync("control",bytes);',
        "globalThis.*",
      ],
      [
        'const {writeTextFile:publish}=Deno; publish("control","{}");',
        "Deno.*",
      ],
      [
        'const runtime=globalThis.Deno; runtime.writeFileSync("control",bytes);',
        "globalThis.Deno",
      ],
      [
        'const box={write:Deno.writeTextFile}; box.write("control","{}");',
        "Deno.writeTextFile",
      ],
      [
        'import * as fs from "node:fs/promises"; fs.writeFile("control","{}");',
        "module:node:fs/promises",
      ],
      ['import {writeFileSync as publish} from "node:fs";', "module:node:fs"],
      ['import {copy} from "@std/fs";', "module:@std/fs"],
      [
        'import {syncStatusChannel} from "public"; Deno.writeTextFile("control","{}");',
        "Deno.writeTextFile",
      ],
      [
        'import {publishRecord as raw} from "records"; raw("control","{}");',
        "module:tests/helpers/process_records.ts",
      ],
    ]
  ) {
    Deno.test(`P11 registration: ${file} rejects raw record capability ${text}`, () => {
      const sites = analyzeOwnership([{
        file,
        text,
        imports: {
          public: "tests/helpers/sync_status_control.ts",
          records: "tests/helpers/process_records.ts",
          "@std/fs": "@std/fs",
        },
      }], RECORD_PILOT_OWNERSHIP);
      assertUnowned(sites, capability);
      assert(inventoryErrors(sites, [], new Set()).length > 0);
    });
  }
}
for (
  const module of [
    RECORD_CHANNEL,
    "tests/helpers/process_records.ts",
    RECORD_PUBLICATION,
  ]
) {
  for (
    const text of [
      'import * as owner from "private";',
      'import {recordChannel as create} from "private";',
      'import "private";',
      'import {} from "private";',
      'export {} from "private";',
      'export * from "private";',
      'export * as owner from "private";',
      'export {publishRecord as publish} from "private";',
      'await import("private");',
      'import owner = require("private");',
    ]
  ) {
    Deno.test(`P11 registration: ${module} denies ${text}`, () => {
      const sites = analyzeOwnership([{
        file: "tests/ordinary.cts",
        text,
        imports: { private: module },
      }], RECORD_OWNERSHIP);
      assertUnowned(sites, `module:${module}`);
      assertEquals(sites.map((site) => site.source), ['"private"']);
    });
  }
}
Deno.test("P11 registration: private re-export rejects its producer, not the downstream alias", () => {
  const sites = analyzeOwnership([{
    file: "shared/raw.ts",
    text: 'export {publishRecord as publish} from "records";',
    imports: { records: "tests/helpers/process_records.ts" },
  }, {
    file: SYNC_NATIVE,
    text: 'import {publish} from "bridge"; publish(path,bytes);',
    imports: { bridge: "shared/raw.ts" },
  }], RECORD_OWNERSHIP);
  assertEquals(sites.map((site) => site.file), ["shared/raw.ts"]);
});

Deno.test("P11 registration: resolved std filesystem root and copy subpath reject at a bridge producer", () => {
  for (const module of ["jsr:@std/fs@^1.0.20", "jsr:/@std/fs@^1.0.20/copy"]) {
    assertUnowned(
      analyzeOwnership([{
        file: "shared/bridge.ts",
        text: 'export {copy} from "fs";',
        imports: { fs: module },
      }], RECORD_OWNERSHIP),
      `module:${module}`,
    );
  }
});

Deno.test("P11 registration: Node filesystem re-export is rejected in the producer", () => {
  const sites = analyzeOwnership([{
    file: "shared/record-alias.mjs",
    text: 'export {writeFileSync as publish} from "node:fs";',
  }, {
    file: SYNC_NATIVE,
    text: 'import {publish} from "alias"; publish(path,bytes);',
    imports: { alias: "shared/record-alias.mjs" },
  }], RECORD_OWNERSHIP);
  assertEquals(sites.map((site) => site.file), ["shared/record-alias.mjs"]);
  assertUnowned(sites, "module:node:fs");
});
Deno.test("P11 registration: schemas and type-only dependencies are public without directory or channel construction", () => {
  assertEquals(
    analyzeOwnership([{
      file: "tests/ordinary.ts",
      text:
        'import type {RecordDirectory} from "private"; import {objectRecordSchema} from "schema";',
      imports: {
        private: RECORD_CHANNEL,
        schema: "tests/helpers/record_schema.ts",
      },
    }], RECORD_OWNERSHIP),
    [],
  );
});
for (
  const [text, capability] of [
    ["Promise.race([]);", "Promise.race"],
    ['Deno.watchFs("control");', "Deno.watchFs"],
    ["setTimeout(()=>{},1);", "setTimeout.*"],
    ["const timer=globalThis.setTimeout;", "globalThis.setTimeout"],
  ]
) {
  Deno.test(`P11 registration: channel cannot restore private observer ${text}`, () =>
    assertUnowned(
      analyzeOwnership(
        [{ file: RECORD_CHANNEL, text }],
        RECORD_ENGINE_OWNERSHIP,
      ),
      capability,
    ));
}
Deno.test("P11 registration: complete exact inventory has no owner allowances and rejects copied protocol/data references", async () => {
  const sources = await repositorySources(repositoryRoot()),
    files = new Set(sources.map((source) => source.file));
  const sites = registeredOwnership(sources);
  assertEquals(inventoryErrors(sites, LEGACY_OWNERSHIP, files), []);
  assertEquals(LEGACY_OWNERSHIP.filter((entry) => entry.allowed), []);
  const entry = LEGACY_OWNERSHIP.find((entry) =>
    entry.family === "sync-fixture-data-io"
  )!;
  assert(entry);
  assertEquals(
    LEGACY_OWNERSHIP.filter((entry) => entry.family === "sync-fixture-data-io")
      .length,
    7,
  );
  assert(
    inventoryErrors([...sites, entry], LEGACY_OWNERSHIP, files).some((error) =>
      error.startsWith("unowned capability:")
    ),
  );
});
