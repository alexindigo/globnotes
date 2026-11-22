// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { analyzeOwnership } from "./helpers/ownership_contract.ts";
import {
  FIXTURE_SCOPE_ENGINE,
  NATIVE_FIXTURE_OWNERSHIP,
  NATIVE_FIXTURE_PILOT,
  NATIVE_FIXTURE_SCOPE,
  registeredOwnership,
  RESOURCE_CORE,
} from "./helpers/ownership_rules.ts";

for (const file of [NATIVE_FIXTURE_SCOPE, NATIVE_FIXTURE_PILOT]) {
  for (const module of [FIXTURE_SCOPE_ENGINE, RESOURCE_CORE, "node:fs"]) {
    for (
      const text of [
        'import { createFixtureScope as create } from "raw";',
        'import * as raw from "raw"; raw[input()]();',
        'export {} from "raw";',
        'export * from "raw";',
        'await import("raw");',
        'import { Owner } from "raw"; class Borrower extends Owner {}',
      ]
    ) {
      Deno.test(`native fixture guard: ${file} rejects ${module}: ${text}`, () => {
        assertEquals(
          registeredOwnership([{ file, text, imports: { raw: module } }]).map(
            (site) => ({
              file: site.file,
              capability: site.capability,
              source: site.source,
            }),
          ),
          [
            { file, capability: `module:${module}`, source: '"raw"' },
          ],
        );
      });
    }
  }
  for (
    const [text, capability, source] of [
      ["Deno.removeSync(path);", "Deno.removeSync", "Deno.removeSync"],
      ['Deno["removeSync"](path);', "Deno.*", 'Deno["removeSync"]'],
      ["const raw = Deno;", "Deno.*", "Deno"],
      [
        "const gate = Promise.withResolvers();",
        "Promise.withResolvers",
        "Promise.withResolvers",
      ],
      ["await import(path);", "dynamic-import.*", "import(path)"],
    ]
  ) {
    Deno.test(`native fixture guard: ${file} rejects ${text}`, () => {
      assertEquals(
        registeredOwnership([{ file, text }]).map((site) => ({
          capability: site.capability,
          source: site.source,
        })),
        [{ capability, source }],
      );
    });
  }
  for (
    const [text, reason] of [
      [
        'import raw = require("raw");',
        "'import ... =' can only be used in TypeScript files.",
      ],
      [
        'import type {FixtureScope} from "private";',
        "'import type' declarations can only be used in TypeScript files.",
      ],
    ]
  ) {
    Deno.test(`native fixture guard: ${file} rejects invalid native syntax ${text}`, () => {
      assertThrows(
        () => registeredOwnership([{ file, text }]),
        Error,
        `ownership parse: /repository/${file}: ${reason}`,
      );
    });
  }
  Deno.test(`native fixture guard: ${file} keeps public P03`, () => {
    assertEquals(
      registeredOwnership([{
        file,
        text: 'import {fixtureScope} from "public";',
        imports: {
          public: "tests/helpers/fixture_scope.ts",
          private: FIXTURE_SCOPE_ENGINE,
        },
      }]),
      [],
    );
  });
}

Deno.test("native fixture guard: TS consumers erase private scope type imports only", () => {
  const file = "tests/native-consumer.mts";
  assertEquals(
    analyzeOwnership([{
      file,
      text: 'import type {FixtureScope} from "private";',
      imports: { private: FIXTURE_SCOPE_ENGINE },
    }], NATIVE_FIXTURE_OWNERSHIP),
    [],
  );
  assertEquals(
    analyzeOwnership([{
      file,
      text: 'import owner = require("private");',
      imports: { private: FIXTURE_SCOPE_ENGINE },
    }], NATIVE_FIXTURE_OWNERSHIP).map((site) => ({
      capability: site.capability,
      source: site.source,
    })),
    [
      { capability: `module:${FIXTURE_SCOPE_ENGINE}`, source: '"private"' },
    ],
  );
});

Deno.test("native fixture guard: product cannot acquire the native test facade", () => {
  assertEquals(
    registeredOwnership([{
      file: "server/ordinary.ts",
      text: 'export * from "native";',
      imports: { native: NATIVE_FIXTURE_SCOPE },
    }]).map((site) => ({
      file: site.file,
      capability: site.capability,
      source: site.source,
    })),
    [
      {
        file: "server/ordinary.ts",
        capability: `module:${NATIVE_FIXTURE_SCOPE}`,
        source: '"native"',
      },
    ],
  );
});
