// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import {
  analyzeOwnership,
  PROCESS_OWNERSHIP,
} from "./helpers/ownership_contract.ts";
import { assertUnowned } from "./ownership_review_test.ts";

for (const extension of ["ts", "mjs"]) {
  for (
    const [name, text, capability] of [
      [
        "class heritage",
        'class Launch extends Deno.Command {} new Launch("true").spawn();',
        "Deno.Command",
      ],
      [
        "class expression",
        'const Launch=class extends Deno.Command {}; new Launch("true");',
        "Deno.Command",
      ],
      [
        "global heritage",
        "class X extends globalThis.Deno.Command {}",
        "globalThis.Deno",
      ],
    ]
  ) {
    Deno.test(`root erasure: ${extension} rejects ${name}`, () => {
      assertUnowned(
        analyzeOwnership([{ file: `tests/heritage.${extension}`, text }]),
        capability,
      );
    });
  }
}
for (
  const [name, text, capability] of [
    [
      "internal alias",
      'import Runtime = Deno; new Runtime.Command("true");',
      "Deno.*",
    ],
    [
      "global alias",
      'import R = globalThis; new R.Deno.Command("true");',
      "globalThis.*",
    ],
    [
      "nested namespace alias",
      'namespace Outer { export namespace Inner { export import R = Deno; } } new Outer.Inner.R.Command("true");',
      "Deno.*",
    ],
  ]
) {
  Deno.test(`root erasure: ts rejects ${name}`, () => {
    assertUnowned(
      analyzeOwnership([{ file: "tests/alias.ts", text }]),
      capability,
    );
  });
}

const erased = [
  "class X implements Deno.Command {}",
  "interface X extends Deno.Command {}",
  "const x: typeof Deno = undefined;",
  "type X = typeof Deno;",
  "const x = 1 as typeof Deno;",
  "const x = 1 satisfies typeof Deno;",
  "function f(a: typeof Deno): typeof Deno { return a; }",
  "class X extends Base<Deno.Command> {}",
  "function f<T extends typeof Deno>() {}",
  'import type {Deno} from "types";',
  'import {type Deno} from "types";',
  'export type {Deno} from "types";',
  'import type CP = require("node:child_process");',
  "import type Runtime = Deno;",
  "declare const x: typeof Deno;",
  "declare class X extends Deno.Command {}",
  "declare namespace N { export import Runtime = Deno; }",
];
Deno.test("root erasure: type annotations do not erase adjacent runtime expressions", () => {
  for (
    const text of [
      "const x = Deno as typeof Deno;",
      "const x = Deno satisfies typeof Deno;",
      "function f(): typeof Deno { return Deno; }",
      "class X implements Marker { value = Deno; }",
      "@factory(Deno) class X {}",
    ]
  ) {
    const sites = analyzeOwnership([{ file: "tests/mixed.ts", text }]);
    assertUnowned(sites, "Deno.*");
    assertEquals(sites.map((site) => site.source), ["Deno"]);
  }
});
for (const [index, text] of erased.entries()) {
  Deno.test(`root erasure: erased form ${index + 1} passes and emits no root access`, () => {
    assertEquals(analyzeOwnership([{ file: "tests/erased.ts", text }]), []);
    const result = ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    });
    assert(!result.outputText.includes("Deno"), result.outputText);
    assert(!result.outputText.includes("require("), result.outputText);
  });
}

Deno.test("root erasure: classification applies to every configured root", () => {
  const rules = {
    ...PROCESS_OWNERSHIP,
    roots: { ...PROCESS_OWNERSHIP.roots, Capabilities: { members: [] } },
  };
  for (const root of Object.keys(rules.roots)) {
    assertUnowned(
      analyzeOwnership(
        [{ file: "tests/root.ts", text: `import R = ${root};` }],
        rules,
      ),
      `${root}.*`,
    );
    assertUnowned(
      analyzeOwnership([{
        file: "tests/root.ts",
        text: `class X extends ${root}.Command {}`,
      }], rules),
      `${root}.Command`,
    );
    assertEquals(
      analyzeOwnership([{
        file: "tests/types.ts",
        text: `interface X extends ${root}.Command {}`,
      }], rules),
      [],
    );
  }
});
