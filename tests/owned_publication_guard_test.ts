// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  analyzeOwnership,
  familyInventoryErrors,
  inventoryErrors,
  repositorySources,
  type SourceModule,
} from "./helpers/ownership_contract.ts";
import {
  LEGACY_OWNERSHIP,
  OWNERSHIP_FAMILIES,
} from "./helpers/ownership_legacy.ts";
import {
  PUBLICATION_OWNER,
  PUBLICATION_OWNERSHIP,
  PUBLICATION_PILOT,
  PUBLICATION_PILOT_OWNERSHIP,
  PUBLICATION_PORT,
  PUBLICATION_STORE,
  registeredOwnership,
} from "./helpers/ownership_rules.ts";

const input = (text: string, file = "server/bypass.cts"): SourceModule => ({
  file,
  text,
  imports: {
    owner: PUBLICATION_OWNER,
    port: PUBLICATION_PORT,
    store: PUBLICATION_STORE,
  },
});
for (
  const [specifier, module, owner] of [[
    "owner",
    PUBLICATION_OWNER,
    PUBLICATION_PILOT,
  ], ["port", PUBLICATION_PORT, PUBLICATION_OWNER]]
) {
  Deno.test(`P06 registration: all runtime import forms of ${module} reject at the private import`, () => {
    for (
      const code of [
        `import {prepare as raw} from "${specifier}";`,
        `import * as raw from "${specifier}";`,
        `import raw from "${specifier}";`,
        `import "${specifier}";`,
        `import {} from "${specifier}";`,
        `export {} from "${specifier}";`,
        `export {prepare as raw} from "${specifier}";`,
        `export * from "${specifier}";`,
        `export * as raw from "${specifier}";`,
        `await import("${specifier}");`,
        `import raw = require("${specifier}");`,
      ]
    ) {
      const sites = analyzeOwnership([input(code)], PUBLICATION_OWNERSHIP);
      assertEquals(sites.map((s) => s.capability), [`module:${module}`]);
      assertEquals(sites.map((s) => s.source), [`"${specifier}"`]);
      assertEquals(
        analyzeOwnership([input(code, owner)], PUBLICATION_OWNERSHIP),
        [],
      );
    }
    assertEquals(
      analyzeOwnership(
        [input(`import type {T} from "${specifier}";`)],
        PUBLICATION_OWNERSHIP,
      ),
      [],
    );
  });
}
Deno.test("P06 registration: pilot cannot acquire a raw store or filesystem root, including aliases and computed roots", () => {
  for (
    const [text, capability] of [
      [
        'import {BoundFileStore as Raw} from "store";',
        `module:${PUBLICATION_STORE}`,
      ],
      ['import {} from "store";', `module:${PUBLICATION_STORE}`],
      ['export {} from "store";', `module:${PUBLICATION_STORE}`],
      ['await import("store");', `module:${PUBLICATION_STORE}`],
      [
        'import {writeFile} from "node:fs/promises";',
        "module:node:fs/promises",
      ],
      ["Deno.renameSync(from,to);", "Deno.renameSync"],
      ["Deno.linkSync(from,to);", "Deno.linkSync"],
      ["const runtime=Deno;", "Deno.*"],
      ["const {renameSync: move}=Deno;", "Deno.*"],
      ['Deno["renameSync"](from,to);', "Deno.*"],
    ]
  ) {
    const sites = analyzeOwnership(
      [input(text, PUBLICATION_PILOT)],
      PUBLICATION_PILOT_OWNERSHIP,
    );
    assertEquals(sites.map((s) => s.capability), [capability]);
  }
  assertEquals(
    analyzeOwnership([
      input('import {BoundFileStore} from "store";', PUBLICATION_OWNER),
    ], PUBLICATION_PILOT_OWNERSHIP),
    [],
  );
  assertEquals(
    analyzeOwnership(
      [input("Deno.renameSync(from,to);", PUBLICATION_STORE)],
      PUBLICATION_PILOT_OWNERSHIP,
    ),
    [],
  );
  assertEquals(
    analyzeOwnership([
      input(
        'import type {StoredConfigSnapshot} from "store";',
        PUBLICATION_PILOT,
      ),
    ], PUBLICATION_PILOT_OWNERSHIP),
    [],
  );
});
Deno.test("P06 registration: bridge aliases fail at their producer, not a downstream alias call", () => {
  const sites = analyzeOwnership([
    input(
      'export {prepare as forwarded} from "port";',
      "shared/publication-bridge.ts",
    ),
    {
      file: "server/consumer.ts",
      text: 'import {forwarded} from "bridge"; forwarded();',
      imports: { bridge: "shared/publication-bridge.ts" },
    },
  ], PUBLICATION_OWNERSHIP);
  assertEquals(sites.map((s) => [s.file, s.capability]), [[
    "shared/publication-bridge.ts",
    `module:${PUBLICATION_PORT}`,
  ]]);
});
Deno.test("P06 registration: owner consumers, exact occurrences and residual closure remain enforced", () => {
  const sites = analyzeOwnership(
    [input('import "port";')],
    PUBLICATION_OWNERSHIP,
  );
  const entries = sites.map((s) => ({
    ...s,
    family: "owned-publication-pilot",
    replacement: "P06",
    consumers: ["tests/owned_publication_test.ts"],
  }));
  const files = new Set(entries[0].consumers);
  assertEquals(inventoryErrors(sites, entries, files), []);
  assert(inventoryErrors([...sites, ...sites], entries, files).length > 0);
  assert(
    familyInventoryErrors(entries, OWNERSHIP_FAMILIES, files, new Set()).some(
      (e) => e.startsWith("residual inventory declared closed:"),
    ),
  );
  assert(
    familyInventoryErrors(
      [],
      {
        "owned-publication-pilot":
          OWNERSHIP_FAMILIES["owned-publication-pilot"],
      },
      new Set(),
      new Set(),
    ).some((e) => e.startsWith("lost owned-publication-pilot consumer:")),
  );
});
Deno.test("P06 registration: real modules use registered boundaries, without flow hooks or owner allowances", async () => {
  const sources = await repositorySources(
      fromFileUrl(new URL("../", import.meta.url)),
    ),
    files = new Set(sources.map((s) => s.file));
  for (const module of [PUBLICATION_OWNER, PUBLICATION_PORT]) {
    assert(files.has(module));
    for (const owner of PUBLICATION_OWNERSHIP.modules[module]) {
      assert(files.has(owner), `lost owner: ${owner}`);
    }
  }
  assertEquals(
    inventoryErrors(
      registeredOwnership(sources),
      LEGACY_OWNERSHIP,
      files,
    ),
    [],
  );
  const pilot = sources.filter((s) =>
    [PUBLICATION_PILOT, PUBLICATION_OWNER].includes(s.file)
  );
  assertEquals(pilot.length, 2);
  assertEquals(analyzeOwnership(pilot, PUBLICATION_PILOT_OWNERSHIP), []);
  assertEquals(registeredOwnership(sources).length, LEGACY_OWNERSHIP.length);
  assertEquals(LEGACY_OWNERSHIP.filter((e) => e.allowed).length, 0);
  assertEquals(
    LEGACY_OWNERSHIP.filter((e) => e.family === "owned-publication-pilot"),
    [],
  );
});
