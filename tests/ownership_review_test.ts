// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  analyzeOwnership,
  inventoryErrors,
  type OwnershipSite,
  OwnershipSourceOwner,
  PROCESS_OWNERSHIP,
  type SourceModule,
} from "./helpers/ownership_contract.ts";

/** Shared by every bypass control: neither missing sites nor missing inventory
 * errors can pass. Expected capabilities are supplied independently of results. */
export function assertUnowned(
  sites: OwnershipSite[],
  capability: string,
  errors = inventoryErrors(sites, [], new Set()),
) {
  assert(sites.length > 0, "expected a root/import violation");
  assert(
    sites.some((site) => site.capability === capability),
    `missing ${capability}: ${JSON.stringify(sites)}`,
  );
  assert(errors.length > 0, "expected an inventory error");
  assertEquals(
    errors,
    sites.map((site) =>
      `unowned capability: ${site.file}:${site.line}: ${site.capability}: ${site.source}`
    ),
  );
}
const source = (
  text: string,
  imports?: Record<string, string>,
): SourceModule => ({ file: "tests/review.mjs", text, imports });

Deno.test("review 1: import-map aliases are classified by resolved identity in every runtime form", () => {
  for (
    const text of [
      'import {spawn as launch} from "jobs";',
      'import * as jobs from "jobs";',
      'import jobs from "jobs";',
      'import "jobs";',
      'import {} from "jobs";',
      'export {} from "jobs";',
      'export {spawn as launch} from "jobs";',
      'export * from "jobs";',
      'export * as jobs from "jobs";',
      'await import("jobs");',
      'import jobs = require("jobs");',
    ]
  ) {
    assertUnowned(
      analyzeOwnership([{
        ...source(text, { jobs: "node:child_process" }),
        file: "tests/review.ts",
      }]),
      "module:node:child_process",
    );
  }
});
Deno.test("review 2: reassigned object shapes are rejected at each Deno root", () => {
  const sites = analyzeOwnership([
    source(
      'let box={first:Deno}; box={current:Deno}; new box.current.Command("true");',
    ),
  ]);
  assertUnowned(sites, "Deno.*");
  assertEquals(sites.map((site) => site.source), ["Deno", "Deno"]);
});
Deno.test("review 3: imports require a literal and a graph edge, never constant folding", () => {
  for (
    const text of [
      'import("../server/"+"raw.ts");',
      'const name="node:path"; import(name);',
      "import(`node:path`);",
      'import(new URL("./raw.ts",import.meta.url).href);',
    ]
  ) assertUnowned(analyzeOwnership([source(text)]), "dynamic-import.*");
  assertUnowned(
    analyzeOwnership([source('import("./raw.ts");')]),
    "unresolved-import",
  );
  assertUnowned(
    analyzeOwnership([source('import "opaque-alias";')]),
    "unresolved-import",
  );
  assertEquals(
    analyzeOwnership([
      source('import("node:path");', { "node:path": "node:path" }),
    ]),
    [],
  );
  assertEquals(
    analyzeOwnership([
      source('import("package");', { package: "npm:package@1.0.0" }),
    ]),
    [],
  );
});
Deno.test("review 4: empty native re-exports load protected modules", () => {
  assertUnowned(
    analyzeOwnership([source('export {} from "node:child_process";')]),
    "module:node:child_process",
  );
});
Deno.test("review 5: selective re-exports do not inherit a sibling capability but its producer rejects", () => {
  const sites = analyzeOwnership([
    {
      file: "shared/raw.js",
      text: 'export const launch=Deno.Command; export const label="safe";',
    },
    source('export {label} from "../shared/raw.js";', {
      "../shared/raw.js": "shared/raw.js",
    }),
  ]);
  assertUnowned(sites, "Deno.Command");
  assertEquals(sites.map((site) => site.file), ["shared/raw.js"]);
  assertEquals(
    analyzeOwnership([
      { file: "shared/data.js", text: 'export const label="safe";' },
      source('export {label} from "../shared/data.js";', {
        "../shared/data.js": "shared/data.js",
      }),
    ]),
    [],
  );
});
Deno.test("review 6: type-only import-equals is erased, runtime import-equals rejects", () => {
  assertEquals(
    analyzeOwnership([{
      file: "tests/types.cts",
      text: 'import type CP = require("node:child_process");',
    }]),
    [],
  );
  assertUnowned(
    analyzeOwnership([{
      file: "tests/value.cts",
      text: 'import CP = require("node:child_process");',
    }]),
    "module:node:child_process",
  );
});
Deno.test("review 7: default-export objects cannot capture a runtime root", () => {
  assertUnowned(
    analyzeOwnership([source("export default {runtime:Deno};")]),
    "Deno.*",
  );
  assertEquals(
    analyzeOwnership([source('export default {label:"data"};')]),
    [],
  );
});
Deno.test("review 8: credential roots belong to explicit later registrations, including property writes", () => {
  const input = {
    file: "server/auth/control.ts",
    text: "codecs.encoder=TextEncoder;",
  };
  assertEquals(
    analyzeOwnership([input]),
    [],
    "P01 must not claim credential privacy",
  );
  const rules = {
    ...PROCESS_OWNERSHIP,
    roots: { ...PROCESS_OWNERSHIP.roots, TextEncoder: { members: [] } },
  };
  assertUnowned(analyzeOwnership([input], rules), "TextEncoder.*");
});
Deno.test("review 9: mts and cts modules are discovered, parsed and guarded", async () => {
  const root = await Deno.makeTempDir({ prefix: "ownership-extensions-" });
  try {
    for (const directory of ["server", "tests", "client/tests/e2e"]) {
      await Deno.mkdir(`${root}/${directory}`, { recursive: true });
    }
    for (
      const [file, text] of Object.entries({
        "deno.json": '{"imports":{"jobs":"node:child_process"}}',
        "server/entry.ts": "export {};",
        "client/tests/e2e/entry.mjs": "export {};",
        "tests/first_test.mts":
          '; import {spawn as launch} from "jobs"; new Deno.Command("true");',
        "tests/second_test.cts":
          '; import CP = require("node:child_process"); new Deno.Command("true");',
        "tests/third_test.tsx": '; new Deno.Command("true");',
        "tests/fourth_test.jsx": '; new Deno.Command("true");',
      })
    ) await Deno.writeTextFile(`${root}/${file}`, text);
    const { sources, sites, coverage } = await new OwnershipSourceOwner(root)
      .analyze(root);
    assertEquals(sources.map((s) => s.file), coverage.files);
    assertEquals(coverage.roots.tests, 4);
    assertEquals(
      sources.find((s) => s.file === "tests/first_test.mts")?.imports?.jobs,
      "node:child_process",
    );
    assertUnowned(sites, "Deno.Command");
    assertEquals(
      sites.filter((s) => s.capability === "module:node:child_process").length,
      2,
    );
    assertEquals(
      sites.filter((s) => s.capability === "Deno.Command").map((s) => s.file),
      [
        "tests/first_test.mts",
        "tests/fourth_test.jsx",
        "tests/second_test.cts",
        "tests/third_test.tsx",
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("review 10: bypass assertions cannot pass with empty sites or inventory errors", () => {
  assertThrows(
    () => assertUnowned([], "Deno.Command"),
    Error,
    "expected a root/import violation",
  );
  const sites = analyzeOwnership([source('new Deno.Command("true");')]);
  assertThrows(
    () => assertUnowned(sites, "Deno.Command", []),
    Error,
    "expected an inventory error",
  );
  assertUnowned(sites, "Deno.Command");
});

Deno.test("root policy: namespace escapes, dynamic evaluation and process control reject directly", () => {
  for (const root of ["Deno", "globalThis", "self", "window"]) {
    for (
      const text of [
        `const alias=${root};`,
        `const box={${root}};`,
        `consume(${root});`,
        `const copy={...${root}};`,
        `export {${root}};`,
        `const {Command}= ${root};`,
        `${root}["test"];`,
        `typeof ${root};`,
      ]
    ) assertUnowned(analyzeOwnership([source(text)]), `${root}.*`);
  }
  for (
    const [text, capability] of [
      ["Deno.kill(123);", "Deno.kill"],
      ["Deno.run({});", "Deno.run"],
      ["Deno.exit();", "Deno.exit"],
      ["const evaluate=eval;", "eval.*"],
      ['(0,eval)("source");', "eval.*"],
      ['new Function("source");', "Function.*"],
      ["const Constructor=Function;", "Function.*"],
      ["globalThis.Deno;", "globalThis.Deno"],
      ["window.Function;", "window.Function"],
      ["self.eval;", "self.eval"],
      ["global.process;", "global.process"],
      ['module.require("child_process");', "module.require"],
    ]
  ) assertUnowned(analyzeOwnership([source(text)]), capability);
  assertEquals(
    analyzeOwnership([{
      file: "tests/helpers/process.ts",
      text: 'new Deno.Command("true");',
    }]),
    [],
  );
  assertUnowned(
    analyzeOwnership([{
      file: "tests/helpers/process.ts",
      text: "export const runtime=Deno;",
    }]),
    "Deno.*",
  );
});

Deno.test("root policy: erased declarations do not manufacture runtime shadows", () => {
  for (
    const text of [
      'declare const Deno: any; new Deno.Command("true");',
      'import type {Deno} from "types"; new Deno.Command("true");',
      'import {type Deno} from "types"; new Deno.Command("true");',
      'type Deno = unknown; new Deno.Command("true");',
    ]
  ) {
    assertUnowned(
      analyzeOwnership([{ file: "tests/erased.ts", text }]),
      "Deno.Command",
    );
  }
});

Deno.test("root registrations: owned members override public members and private modules reject all runtime imports", () => {
  const owner = "tests/helpers/fixture_scope.ts";
  const rules = {
    roots: {
      ...PROCESS_OWNERSHIP.roots,
      Deno: {
        ...PROCESS_OWNERSHIP.roots.Deno,
        ownedMembers: {
          ...PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
          makeTempDir: [owner],
        },
      },
    },
    modules: {
      ...PROCESS_OWNERSHIP.modules,
      "shared/private-engine.js": [owner],
    },
  };
  assertUnowned(
    analyzeOwnership([source("Deno.makeTempDir();")], rules),
    "Deno.makeTempDir",
  );
  assertEquals(
    analyzeOwnership([{ file: owner, text: "Deno.makeTempDir();" }], rules),
    [],
  );
  const imported = source('import {create as use} from "engine";', {
    engine: "shared/private-engine.js",
  });
  assertUnowned(
    analyzeOwnership([imported], rules),
    "module:shared/private-engine.js",
  );
  assertEquals(analyzeOwnership([{ ...imported, file: owner }], rules), []);
});

Deno.test("root references: data keys, export names and JSX intrinsic names are not global values", () => {
  assertEquals(
    analyzeOwnership([{
      file: "tests/data.tsx",
      text:
        'const object={Deno:"label",eval:"label"}; const label="data"; export {label as Deno}; const element=<globalThis/>;',
    }]),
    [],
  );
  assertUnowned(
    analyzeOwnership([{
      file: "tests/value.tsx",
      text: "const element=<Deno/>;",
    }]),
    "Deno.*",
  );
});
