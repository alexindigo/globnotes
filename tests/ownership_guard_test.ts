// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import ts from "typescript";
import {
  analyzeOwnership,
  assertOwnershipParse,
  familyInventoryErrors,
  inventoryErrors,
  OwnershipSourceOwner,
  PROCESS_OWNERSHIP,
  type SourceModule,
} from "./helpers/ownership_contract.ts";
import { command, DENO } from "./helpers/process.ts";
import { assertUnowned } from "./ownership_review_test.ts";
import "./ownership_erasure_test.ts";

// These are source inputs, not executed counterexamples. The isolation contract
// imports this file so parser-negative controls are always selected as well.
const rejected = [
  '; new Deno.Command("true");',
  'function local() {}; new Deno.Command("true");',
  '; const {spawn: launch} = await import("node:child_process"); launch("true");',
  'new Deno.Command("true");',
  'const runtime = Deno; new runtime.Command("true");',
  'const {Command: Launch} = Deno; new Launch("true");',
  'const name = "Com" + "mand"; new Deno[name]("true");',
  'const runtime = globalThis["Deno"]; const C = runtime.Command; new C("true");',
  'const {Deno: runtime} = globalThis; new runtime.Command("true");',
  'new globalThis.Deno.Command("true");',
  'import {spawn as launch} from "node:child_process"; launch("true");',
  'import * as cp from "child_process"; cp["spawn"]("true");',
  'const {spawn: launch} = await import("node:child_process"); launch("true");',
  'const key = input(); Deno[key]("true");',
  "const key = input(); globalThis[key];",
  "const module = await import(input()); module.launch();",
  'import {command} from "./process.ts"; new Deno.Command("true");',
  'import {createRequire as cr} from "node:module"; const req = cr(import.meta.url); req("child_process");',
  'process.getBuiltinModule("child_process").spawn("true");',
  'Reflect.get(Deno, "Command");',
  'let runtime; runtime = Deno; new runtime.Command("true");',
  'const box = {runtime: Deno}; new box.runtime.Command("true");',
  'const runtime = Deno as typeof Deno; new runtime["Command"]("true");',
  'new (Deno[`${"Command"}`])("true");',
  'function runtime() { return Deno; } new (runtime().Command)("true");',
  'const [runtime] = [Deno]; new runtime.Command("true");',
  'const box = {runtime: Deno}; const key = input(); new box[key].Command("true");',
  'export {spawn as launch} from "node:child_process";',
  'export * from "node:child_process";',
  'import cp = require("node:child_process"); cp.spawn("true");',
  'let runtime=Deno; use(runtime); runtime={}; new runtime.Command("true");',
  'const \u03bb = "non-ASCII prefix"; new Deno.Command("true");',
  'function runtime() { return globalThis.Deno; } new (runtime().Command)("true");',
  'function run(runtime = globalThis.Deno) { new runtime.Command("true"); } run();',
  'const {runtime = globalThis.Deno} = {}; new runtime.Command("true");',
  'const f = function Deno() {}; new Deno.Command("true");',
  'const f = class Deno {}; new Deno.Command("true");',
  'const {Deno: {Command: Launch}} = globalThis; new Launch("true");',
  "const {Deno: {Command: Launch}} = globalThis; consume(Launch);",
  'import * as runtime from "node:module"; runtime[input()]("child_process");',
  'import process from "node:process"; process[input()]("child_process");',
  "const box = {runtime: Deno}; opaque(box);",
  'function factory() {return {runtime: Deno};} new factory().runtime.Command("true");',
  'let runtime; ({runtime} = {runtime: Deno}); new runtime.Command("true");',
];
const expectedCapabilities = [
  "Deno.Command",
  "Deno.Command",
  "module:node:child_process",
  "Deno.Command",
  "Deno.*",
  "Deno.*",
  "Deno.*",
  "globalThis.*",
  "globalThis.*",
  "globalThis.Deno",
  "module:node:child_process",
  "module:node:child_process",
  "module:node:child_process",
  "Deno.*",
  "globalThis.*",
  "dynamic-import.*",
  "Deno.Command",
  "module:node:module",
  "process.getBuiltinModule",
  "Deno.*",
  "Deno.*",
  "Deno.*",
  "Deno.*",
  "Deno.*",
  "Deno.*",
  "Deno.*",
  "Deno.*",
  "module:node:child_process",
  "module:node:child_process",
  "module:node:child_process",
  "Deno.*",
  "Deno.Command",
  "globalThis.Deno",
  "globalThis.Deno",
  "globalThis.Deno",
  "Deno.Command",
  "Deno.Command",
  "globalThis.*",
  "globalThis.*",
  "module:node:module",
  "module:node:process",
  "Deno.*",
  "Deno.*",
  "Deno.*",
];
const BUILTINS = {
  "node:child_process": "node:child_process",
  "child_process": "node:child_process",
  "node:module": "node:module",
  "node:process": "node:process",
};
for (const extension of ["ts", "mjs"]) {
  for (const [index, source] of rejected.entries()) {
    if (
      extension === "mjs" &&
      (source.includes(" as typeof") || source.includes("import cp ="))
    ) continue;
    Deno.test(`ownership guard: ${extension} rejects bypass ${index + 1}`, () => {
      const sites = analyzeOwnership([{
        file: `tests/control.${extension}`,
        text: source,
        imports: BUILTINS,
      }]);
      assertUnowned(sites, expectedCapabilities[index]);
    });
  }
  Deno.test(`ownership guard: ${extension} permits allowed code and lexical shadowing`, () => {
    const source = `
      ; // Empty statements and comments are legal, not blanket rejections.
      import {command as launch} from "./process.ts";
      import {join} from "node:path";
      const comment = "new Deno.Command()"; // new Deno.Command()
      launch(join("a", "b")).spawn();
      Deno.readTextFile("fixture");
      const obj = {Command: () => 1}; obj.Command();
      function local(Deno) { return new Deno.Command(); }
      { const Deno = obj; Deno.Command(); }
      const f = (globalThis) => globalThis[unknown];
    `;
    assertEquals(
      analyzeOwnership([{
        file: `tests/allowed.${extension}`,
        text: source,
        imports: {
          "./process.ts": "tests/helpers/process.ts",
          "node:path": "node:path",
        },
      }]),
      [],
    );
  });
}

Deno.test("ownership guard: aliases and re-exports cannot hide their root producer", () => {
  const sources: SourceModule[] = [
    { file: "tests/raw.ts", text: "export const launch = Deno.Command;" },
    {
      file: "tests/bridge.mjs",
      text: 'export {launch as start} from "./raw.ts";',
      imports: { "./raw.ts": "tests/raw.ts" },
    },
    {
      file: "tests/all.mjs",
      text: 'export * from "./bridge.mjs";',
      imports: { "./bridge.mjs": "tests/bridge.mjs" },
    },
    {
      file: "tests/consumer.mjs",
      text: 'import * as facade from "./all.mjs"; new facade["start"]("true");',
      imports: { "./all.mjs": "tests/all.mjs" },
    },
  ];
  const sites = analyzeOwnership(sources);
  assertUnowned(sites, "Deno.Command");
  assertEquals(sites.map((site) => site.file), ["tests/raw.ts"]);
});

for (const extension of ["ts", "mjs"]) {
  Deno.test(`ownership completeness: ${extension} rejects syntax errors anywhere`, () => {
    for (
      const text of [
        "const = ;",
        '; new Deno.Command("true"); const broken = ;',
        "function local() {",
        'const text = "unterminated',
      ]
    ) {
      assertThrows(
        () => analyzeOwnership([{ file: `tests/broken.${extension}`, text }]),
        Error,
        "ownership parse:",
      );
    }
  });
  Deno.test(`ownership completeness: ${extension} checks an aliased runtime re-export after empty statements`, () => {
    const sources: SourceModule[] = [
      {
        file: `shared/raw.${extension}`,
        text: "; const runtime = Deno; export {runtime as exposed};",
      },
      {
        file: `shared/bridge.${extension}`,
        text: `; export {exposed as runtime} from "./raw.${extension}";`,
        imports: { [`./raw.${extension}`]: `shared/raw.${extension}` },
      },
      {
        file: `tests/consumer.${extension}`,
        text:
          `; import {runtime as platform} from "../shared/bridge.${extension}"; new platform.Command("true");`,
        imports: {
          [`../shared/bridge.${extension}`]: `shared/bridge.${extension}`,
        },
      },
    ];
    const sites = analyzeOwnership(sources);
    assertUnowned(sites, "Deno.*");
    assertEquals(sites.map((site) => site.file), [`shared/raw.${extension}`]);
  });
  Deno.test(`ownership completeness: ${extension} allows empty and trivia-only modules`, () => {
    for (
      const text of [
        "",
        ";",
        ";;; // trailing comment\n",
        "/* only a comment */",
        '\ufeff; const text = "allowed";\n',
      ]
    ) {
      assertEquals(
        analyzeOwnership([{ file: `tests/empty.${extension}`, text }]),
        [],
      );
    }
  });
}

Deno.test("ownership completeness: a short or truncated AST cannot claim full coverage", () => {
  const text = '; new Deno.Command("true"); // trailing trivia';
  const ast = () =>
    ts.createSourceFile(
      "tests/truncated.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
    );
  assertOwnershipParse(ast(), text);
  const short = { ...ast(), end: text.length - 1 };
  assertThrows(
    () => assertOwnershipParse(short, text),
    Error,
    "incomplete source span",
  );
  const full = ast();
  const truncated = {
    ...full,
    statements: ts.factory.createNodeArray([full.statements[0]]),
  };
  assertThrows(
    () => assertOwnershipParse(truncated, text),
    Error,
    "incomplete EOF span",
  );
  const unchecked = {
    ...truncated,
    endOfFileToken: {
      ...truncated.endOfFileToken,
      pos: truncated.statements[0].end,
    },
  };
  assertThrows(
    () => assertOwnershipParse(unchecked, text),
    Error,
    "unchecked source suffix",
  );
  const gap = {
    ...full,
    statements: ts.factory.createNodeArray([full.statements[0], {
      ...full.statements[1],
      pos: full.statements[1].pos + 1,
    }]),
  };
  assertThrows(
    () => assertOwnershipParse(gap, text),
    Error,
    "incomplete statement span",
  );
});

Deno.test("ownership completeness: one sibling's bindings or syntax cannot hide another module", () => {
  const shadow = {
    file: "tests/shadow.ts",
    text: "const Deno = {Command() {}}; new Deno.Command();",
  };
  const raw = { file: "tests/raw.mjs", text: '; new Deno.Command("true");' };
  const sites = analyzeOwnership([shadow, raw]);
  assertEquals(sites.filter((site) => site.file === shadow.file), []);
  assert(
    sites.some((site) =>
      site.file === raw.file && site.capability === "Deno.Command"
    ),
  );
  for (
    const sources of [[shadow, { ...raw, text: "; const = ;" }], [{
      ...shadow,
      text: "function broken(",
    }, raw]]
  ) {
    assertThrows(() => analyzeOwnership(sources), Error, "ownership parse:");
  }
});

Deno.test("ownership bindings: JavaScript global expandos do not create lexical shadows", () => {
  for (const extension of ["ts", "mjs"]) {
    const sites = analyzeOwnership([
      {
        file: "shared/expando.mjs",
        text: "export {}; globalThis.window = {crypto: globalThis.crypto};",
      },
      {
        file: `tests/consumer.${extension}`,
        text:
          '; import {command as owned} from "./helpers/process.ts"; const runtime = globalThis["Deno"]; new runtime["Command"]("true");',
      },
    ]);
    assertUnowned(sites, "globalThis.*");
  }
});

Deno.test("ownership guard: types do not acquire runtime capabilities", () => {
  assertEquals(
    analyzeOwnership([{
      file: "tests/types.ts",
      text: `
    import type {ChildProcess} from "node:child_process";
    import {type SpawnOptions} from "node:child_process";
    export {type SpawnOptions} from "node:child_process";
    type CommandType = Deno.Command;
  `,
    }]),
    [],
  );
});

Deno.test("ownership guard: namespace imports and asynchronous import callbacks cannot hide raw exports", () => {
  for (
    const text of [
      'import * as runtime from "./raw.js"; opaque(runtime);',
      'import("./raw.js").then(({launch}) => new launch("true"));',
      'import runtime from "./raw.js"; opaque(runtime);',
    ]
  ) {
    const sites = analyzeOwnership([
      {
        file: "shared/raw.js",
        text: "export const launch = Deno.Command; export default {launch};",
      },
      {
        file: "tests/consumer.mjs",
        text,
        imports: { "./raw.js": "shared/raw.js" },
      },
    ]);
    assertUnowned(sites, "Deno.Command");
    assert(
      sites.some((site) =>
        site.file === "shared/raw.js" && site.capability === "Deno.Command"
      ),
    );
  }
});

Deno.test("ownership guard: real Deno graph resolves native aliases through local transitives", async () => {
  const root = await Deno.makeTempDir({ prefix: "ownership-imports-" });
  try {
    for (const directory of ["server", "tests", "shared", "client/tests/e2e"]) {
      await Deno.mkdir(`${root}/${directory}`, { recursive: true });
    }
    const files: Record<string, string> = {
      "deno.json": "{}",
      "server/unimported.ts": "; export const notReachedFromTests = true;",
      "shared/raw.js": "; export const launch = globalThis.Deno.Command;",
      "shared/barrel.mjs": 'export {launch as runner} from "./raw.js";',
      "tests/entry.ts": 'import type {CommandOptions} from "./types.ts";',
      "tests/types.ts": "export type CommandOptions = Deno.CommandOptions;",
      "client/tests/e2e/case.mjs":
        '; import {runner as Start} from "../../../shared/barrel.mjs"; ; new Start("true");',
    };
    for (const [file, text] of Object.entries(files)) {
      await Deno.writeTextFile(`${root}/${file}`, text);
    }
    const sources = await new OwnershipSourceOwner(root).sources(root);
    assert(
      sources.some((source) => source.file === "server/unimported.ts"),
      "unimported production module omitted",
    );
    assert(
      sources.some((source) => source.file === "shared/raw.js"),
      "local transitive omitted",
    );
    const sites = analyzeOwnership(sources);
    assertUnowned(sites, "globalThis.Deno");
    assertEquals(sites.map((site) => site.file), ["shared/raw.js"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ownership guard: Unicode ranges identify the exact capability", () => {
  const sites = analyzeOwnership([{
    file: "tests/unicode.mjs",
    text: `const prefix = "${
      String.fromCharCode(955)
    }";\nnew Deno.Command("true");`,
  }]);
  assertEquals(
    sites.map(({ source, line, capability }) => ({ source, line, capability })),
    [{ source: "Deno.Command", line: 2, capability: "Deno.Command" }],
  );
});

Deno.test("ownership guard: native JS uses the same real clean launcher", async () => {
  const file = await Deno.makeTempFile({
    prefix: "ownership-pilot-",
    suffix: ".mjs",
  });
  try {
    const launcher = new URL("./helpers/process.ts", import.meta.url).href;
    const source = `import {command, DENO} from ${JSON.stringify(launcher)};
      const result = await command(DENO, {
        args: ["eval", 'console.log(JSON.stringify({ambient:Deno.env.get("P01_UNOWNED") ?? null, explicit:Deno.env.get("P01_OWNED"), tmp:Deno.env.get("TMPDIR")}))'],
        env: { P01_OWNED: "native-owned" }, clearEnv: false, stdout: "piped", stderr: "piped"
      }).output();
      if (!result.success) throw Error(new TextDecoder().decode(result.stderr));
      console.log(new TextDecoder().decode(result.stdout).trim());`;
    assertEquals(
      analyzeOwnership([{
        file: "client/tests/e2e/pilot.mjs",
        text: source,
        imports: { [launcher]: "tests/helpers/process.ts" },
      }]),
      [],
    );
    await Deno.writeTextFile(file, source);
    const result = await command(DENO, {
      args: ["run", "--allow-env", "--allow-run", file],
      env: { P01_UNOWNED: "must-not-reach-grandchild" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      ambient: null,
      explicit: "native-owned",
      tmp: Deno.env.get("TMPDIR"),
    });
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("ownership guard: exact occurrences, stale entries and consumer loss reject", () => {
  const site = {
    file: "client/tests/e2e/legacy.mjs",
    capability: "Deno.Command",
    line: 1,
    source: "Deno.Command",
    context: 'new Deno.Command("true");',
  };
  const entry = {
    ...site,
    family: "native-server",
    replacement: "A08",
    consumers: ["tests/consumer_test.ts"],
  };
  const files = new Set(entry.consumers);
  assertEquals(inventoryErrors([site], [entry], files), []);
  assertEquals(inventoryErrors([{ ...site, line: 8 }], [entry], files), []);
  assert(
    inventoryErrors([site, site], [entry], files).some((error) =>
      error.startsWith("unowned capability:")
    ),
  );
  assert(
    inventoryErrors([], [entry], files).some((error) =>
      error.startsWith("stale inventory:")
    ),
  );
  assert(
    inventoryErrors([site], [entry], new Set()).some((error) =>
      error.startsWith("missing consumer:")
    ),
  );
  const family = { replacement: "A08", consumers: [...files] };
  assertEquals(
    familyInventoryErrors(
      [entry],
      { "native-server": family },
      files,
      new Set(),
    ),
    [],
  );
  assert(
    familyInventoryErrors([entry], {}, files, new Set()).some((error) =>
      error.startsWith("absent protected family:")
    ),
  );
  assert(
    familyInventoryErrors(
      [entry],
      { "native-server": { ...family, closed: true } },
      files,
      new Set(),
    ).some((error) => error.startsWith("residual inventory declared closed:")),
  );
  assert(
    familyInventoryErrors([], { "native-server": family }, new Set(), new Set())
      .some((error) => error.startsWith("lost native-server consumer:")),
  );
  assert(
    familyInventoryErrors(
      [{ ...entry, allowed: true }],
      { "native-server": { ...family, closed: true } },
      files,
      new Set(),
    ).some((error) => error.startsWith("unapproved allowed site:")),
  );
});

Deno.test("ownership guard: private-module/root registrations replace credential value tracking", () => {
  for (
    const text of [
      'import {totpSecretFromRawKey as decode} from "./credentials.ts"; decode(key);',
      'import * as codec from "./credentials.ts"; codec["totpSecret"+"FromRawKey"](key);',
      'const {decodeBase32: decode} = await import("@std/encoding/base32"); decode(key);',
      'import {totp as verifier} from "otplib"; verifier.check(code, key);',
      "const Encode = globalThis.TextEncoder; new Encode().encode(key);",
      'import {opaqueConsumer} from "./credentials.ts"; new TextEncoder().encode(key);',
      'import * as codec from "./credentials.ts"; codec[input()](key);',
    ]
  ) {
    const sites = analyzeOwnership([{
      file: "server/auth/control.ts",
      text,
      imports: {
        "./credentials.ts": "server/auth/credentials.ts",
        "@std/encoding/base32": "@std/encoding/base32",
      },
    }], {
      roots: { ...PROCESS_OWNERSHIP.roots, TextEncoder: { members: [] } },
      modules: {
        ...PROCESS_OWNERSHIP.modules,
        "server/auth/credentials.ts": ["server/auth/account_credentials.ts"],
        "@std/encoding/base32": ["server/auth/credentials.ts"],
        "otplib": ["server/auth/credentials.ts"],
      },
    });
    const expected = text.includes('"./credentials.ts"')
      ? "module:server/auth/credentials.ts"
      : text.includes('"@std/encoding/base32"')
      ? "module:@std/encoding/base32"
      : text.includes('"otplib"')
      ? "module:otplib"
      : "globalThis.TextEncoder";
    assertUnowned(sites, expected);
  }
  assertEquals(
    inventoryErrors(
      analyzeOwnership([{
        file: "tests/reference.ts",
        text: "new TextEncoder().encode(key);",
      }]),
      [],
      new Set(),
    ),
    [],
  );
});
