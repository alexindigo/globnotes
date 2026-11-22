// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  analyzeOwnership,
  inventoryErrors,
  repositorySources,
} from "./helpers/ownership_contract.ts";
import {
  BOOT_OWNER,
  COMPLETED_BUILD_ENGINE,
  COMPLETED_BUILD_OWNERSHIP,
  LAYOUT_OWNER,
  LAYOUT_OWNER_OWNERSHIP,
  LAYOUT_OWNERSHIP,
  LAYOUT_PILOT_OWNERSHIP,
  PREFIX_LAYOUT,
  PREFIX_LAYOUT_OWNERSHIP,
  registeredOwnership,
} from "./helpers/ownership_rules.ts";
import { LEGACY_OWNERSHIP } from "./helpers/ownership_legacy.ts";
import { assertUnowned } from "./ownership_review_test.ts";
const imports = {
  public: "tests/helpers/fixture_layout.ts",
  fs: "jsr:@std/fs@^1.0.20",
  ensure: "jsr:/@std/fs@^1.0.20/ensure-dir",
};
for (const file of [BOOT_OWNER, PREFIX_LAYOUT]) {
  for (
    const [text, capability] of [
      ["; Deno.makeTempDir();", "Deno.makeTempDir"],
      ["function local() {}; Deno.makeTempDir();", "Deno.makeTempDir"],
      [
        "const {makeTempDir:allocate}=globalThis.Deno; allocate();",
        "globalThis.Deno",
      ],
      [
        'const key="make"+"TempDirSync"; globalThis["Deno"][key]();',
        "globalThis.*",
      ],
      ['Deno.mkdir("unowned");', "Deno.mkdir"],
      ['const allocate=Deno.mkdir; allocate("unowned");', "Deno.mkdir"],
      ['import * as fs from "node:fs"; fs.mkdir("unowned");', "module:node:fs"],
      ['import {promises as fs} from "node:fs";', "module:node:fs"],
      [
        'import * as fs from "node:fs/promises"; fs[input()]();',
        "module:node:fs/promises",
      ],
      ['import {ensureDir} from "fs";', "module:jsr:@std/fs@^1.0.20"],
      [
        'import {ensureDir as allocate} from "ensure";',
        "module:jsr:/@std/fs@^1.0.20/ensure-dir",
      ],
      [
        'import {copy as copyLiveBuild} from "fs"; copyLiveBuild("client/dist","cwd");',
        "module:jsr:@std/fs@^1.0.20",
      ],
      [
        'import {fixtureLayout} from "public"; Deno.makeTempDir();',
        "Deno.makeTempDir",
      ],
    ]
  ) {
    Deno.test(`P15 registration: ${file} rejects unowned acquisition ${text}`, () =>
      assertUnowned(
        analyzeOwnership(
          [{ file, text, imports }],
          file === PREFIX_LAYOUT
            ? PREFIX_LAYOUT_OWNERSHIP
            : LAYOUT_PILOT_OWNERSHIP,
        ),
        capability,
      ));
  }
}
for (
  const [file, rules] of [
    [BOOT_OWNER, LAYOUT_PILOT_OWNERSHIP],
    [PREFIX_LAYOUT, PREFIX_LAYOUT_OWNERSHIP],
    [LAYOUT_OWNER, LAYOUT_OWNER_OWNERSHIP],
    [COMPLETED_BUILD_ENGINE, COMPLETED_BUILD_OWNERSHIP],
  ] as const
) {
  for (const member of ["truncate", "stdin", "futureFilesystemOperation"]) {
    Deno.test(`P15 allowlist: ${file} rejects ${member}`, () => {
      const sites = analyzeOwnership(
        [{ file, text: `Deno.${member};`, imports }],
        rules,
      );
      assertEquals(
        sites.map((site) => [site.file, site.capability, site.source]),
        [[file, `Deno.${member}`, `Deno.${member}`]],
      );
    });
  }
}
for (
  const text of [
    'import {completeBuild as build} from "private";',
    'import * as owner from "private";',
    'import "private";',
    'import {} from "private";',
    'export {} from "private";',
    'export * from "private";',
    'export * as owner from "private";',
    'export {installCompletedBuild as copy} from "private";',
    'await import("private");',
    'import owner = require("private");',
  ]
) {
  Deno.test(`P15 registration: private producer/installer rejects ${text}`, () => {
    const sites = analyzeOwnership([{
      file: "tests/ordinary.cts",
      text,
      imports: { private: COMPLETED_BUILD_ENGINE },
    }], LAYOUT_OWNERSHIP);
    assertUnowned(sites, `module:${COMPLETED_BUILD_ENGINE}`);
    assertEquals(sites.map((site) => site.source), ['"private"']);
  });
}
Deno.test("P15 registration: build re-export rejects at its producer and public successful-build facade stays narrow", async () => {
  const sites = analyzeOwnership([{
    file: "shared/build-bridge.ts",
    text: 'export {completeBuild as build} from "private";',
    imports: { private: COMPLETED_BUILD_ENGINE },
  }, {
    file: PREFIX_LAYOUT,
    text: 'import {build} from "bridge"; build(scope,produce);',
    imports: { bridge: "shared/build-bridge.ts" },
  }], LAYOUT_OWNERSHIP);
  assertEquals(sites.map((site) => site.file), ["shared/build-bridge.ts"]);
  const publicBuild = await import("./helpers/completed_build.ts");
  assertEquals(Object.keys(publicBuild).sort(), [
    "buildClient",
    "repositoryBuild",
  ]);
  assertEquals(
    analyzeOwnership([{
      file: "tests/build-consumer.ts",
      text:
        'import {buildClient} from "public"; import type {CompletedBuild} from "private";',
      imports: {
        public: "tests/helpers/completed_build.ts",
        private: COMPLETED_BUILD_ENGINE,
      },
    }], LAYOUT_OWNERSHIP),
    [],
  );
});
Deno.test("P15 registration: issued layout consumers still write real product bytes", () => {
  assertEquals(
    analyzeOwnership([{
      file: PREFIX_LAYOUT,
      text:
        'import {fixtureLayout} from "public"; const layout=await fixtureLayout(scope,{}); Deno.writeTextFile(layout.vault+"/Note.md","real bytes");',
      imports,
    }], PREFIX_LAYOUT_OWNERSHIP),
    [],
  );
});
Deno.test("P15 registration: complete inventory removes migrated prefix constructor and retains no owner allowances", async () => {
  const sources = await repositorySources(
      fromFileUrl(new URL("../", import.meta.url)),
    ),
    files = new Set(sources.map((source) => source.file));
  assert(files.has(COMPLETED_BUILD_ENGINE));
  assertEquals(
    inventoryErrors(registeredOwnership(sources), LEGACY_OWNERSHIP, files),
    [],
  );
  assertEquals(
    LEGACY_OWNERSHIP.filter((entry) => entry.file === PREFIX_LAYOUT),
    [],
  );
  assertEquals(LEGACY_OWNERSHIP.filter((entry) => entry.allowed), []);
});
