// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type Change,
  type Context,
  loadContext,
  parseNameStatus,
  selectChecks,
  SHARED_INPUTS,
  STATIC_GATES,
  validateSelection,
} from "../scripts/select-checks.ts";

function fixture(): Context {
  return {
    files: [
      "tests/leaf_test.ts",
      "tests/boot_test.ts",
      "tests/literal_test.ts",
      "tests/helper_test.ts",
      "tests/shared_test.ts",
      "tests/plugin_test.ts",
      "tests/test_isolation_contract_test.ts",
      "tests/devcontainer_caps_test.ts",
      "tests/timing/slow_test.ts",
    ],
    imports: {
      "tests/leaf_test.ts": ["server/leaf.ts"],
      "tests/boot_test.ts": ["tests/helpers/boot.ts"],
      "tests/literal_test.ts": [],
      "tests/helper_test.ts": ["tests/leaf_test.ts"],
      "tests/shared_test.ts": ["shared/uuid.ts"],
      "tests/plugin_test.ts": ["plugins/sample/plugin.js"],
      "tests/test_isolation_contract_test.ts": [],
      "tests/devcontainer_caps_test.ts": [],
      // These edges must never be followed by selection.
      "tests/helpers/boot.ts": ["server/main.ts"],
      "server/main.ts": ["server/leaf.ts"],
      "server/leaf.ts": ["shared/uuid.ts"],
      "tests/timing/slow_test.ts": ["server/leaf.ts"],
    },
  };
}
const modified = (path: string): Change => ({
  status: "M",
  path,
  removed: false,
});
const select = (...paths: string[]) =>
  selectChecks(paths.map(modified), fixture());

Deno.test("select-checks: every change gets whole-tree static gates and contracts", () => {
  for (const paths of [[], ["README.md"], ["server/unused.ts"], ["unknown"]]) {
    const selected = select(...paths);
    assert(STATIC_GATES.every((gate) => selected.gates.includes(gate)));
    assertEquals(selected.contractTests, [
      "tests/test_isolation_contract_test.ts",
      "tests/devcontainer_caps_test.ts",
    ]);
    assert(selected.reasons.length > 0);
    validateSelection(selected);
  }
});

Deno.test("select-checks: server tests use direct imports only, not boot or transitive graphs", () => {
  const selected = select("server/leaf.ts");
  assertEquals(selected.gates, [...STATIC_GATES, "server"]);
  assertEquals(selected.serverTests, ["tests/leaf_test.ts"]);
  assertEquals(select("server/main.ts").serverTests, []);
  assertEquals(select("server/unused.ts").gates, [...STATIC_GATES]);
  assertEquals(select("tests/helpers/boot.ts").serverTests, [
    "tests/boot_test.ts",
  ]);
  assertEquals(select("tests/leaf_test.ts").serverTests, [
    "tests/leaf_test.ts",
    "tests/helper_test.ts",
  ]);
  assert(
    selected.reasons.some((reason) =>
      reason.rule === "direct imports" &&
      reason.selects.includes("tests/leaf_test.ts")
    ),
  );
});

Deno.test("select-checks: client and shared paths use vitest related without build or controls", () => {
  for (
    const path of [
      "client/views/Home.vue",
      "client/tests/setup.js",
      "client/home.test.js",
    ]
  ) {
    const selected = select(path);
    assertEquals(selected.gates, [...STATIC_GATES, "client"]);
    assertEquals(selected.clientTests, [path]);
  }
  const shared = select("shared/uuid.ts");
  assertEquals(shared.gates, [...STATIC_GATES, "server", "client"]);
  assertEquals(shared.serverTests, ["tests/shared_test.ts"]);
  assertEquals(shared.clientTests, ["shared/uuid.ts"]);
});

Deno.test("select-checks: browser-suite helpers get related tests but never browser gates", () => {
  for (
    const file of [
      "fixture.mjs",
      "legacy-native-suite.mjs",
      "data.json",
      "helper.test.js",
    ]
  ) {
    const path = `client/tests/e2e/${file}`;
    const selected = select(path);
    assertEquals(selected.gates, [...STATIC_GATES, "client"]);
    assertEquals(selected.clientTests, [path]);
    assertEquals(selected.browser, false);
    assertEquals(selected.browserCases, []);
    validateSelection(selected);
  }
});

Deno.test("select-checks: shared inputs select only static gates and frozen install", () => {
  for (const input of SHARED_INPUTS) {
    const path = input.endsWith("/") ? `${input}run.sh` : input;
    const context = fixture();
    context.imports["tests/leaf_test.ts"] = [path];
    const selected = selectChecks([modified(path)], context);
    assertEquals(selected.gates, [...STATIC_GATES], path);
    assertEquals(selected.serverTests, []);
    assertEquals(selected.clientTests, []);
    assertEquals(selected.timingTests, []);
    assert(
      selected.reasons.some((reason) => reason.selects.includes("--frozen")),
    );
  }
});

Deno.test("select-checks: only changed, surviving timing test files run", () => {
  const selected = select("tests/timing/slow_test.ts");
  assertEquals(selected.gates, [...STATIC_GATES, "timing"]);
  assertEquals(selected.timingTests, ["tests/timing/slow_test.ts"]);
  assertEquals(select("tests/timing/helper.ts").gates, [...STATIC_GATES]);
  assertEquals(select("server/leaf.ts").timingTests, []);
  const deleted = selectChecks(
    parseNameStatus("D\0tests/timing/slow_test.ts\0"),
    fixture(),
  );
  assertEquals(deleted.timingTests, []);
});

Deno.test("select-checks: docs get static gates only even if a test imports them", () => {
  for (const path of ["README.md", "docs/guide.md", "client/notes.md"]) {
    const context = fixture();
    context.imports["tests/leaf_test.ts"] = [path];
    assertEquals(selectChecks([modified(path)], context).gates, [
      ...STATIC_GATES,
    ]);
  }
});

Deno.test("select-checks: unknown paths fail closed to static gates plus related tests", () => {
  for (
    const path of [
      "LICENSE",
      "new-top-level.txt",
      "scripts/cold-load.mjs",
      "plugins/sample/plugin.js",
    ]
  ) {
    const selected = select(path);
    assertEquals(selected.clientTests, [path]);
    assertEquals(
      selected.serverTests,
      path.startsWith("plugins/") ? ["tests/plugin_test.ts"] : [],
    );
    assertEquals(selected.timingTests, []);
    assert(selected.reasons.some((reason) => reason.rule === "unknown path"));
    validateSelection(selected);
  }
});

Deno.test("select-checks: malformed name-status fails; renames classify both paths without broadening", () => {
  const changes = parseNameStatus("R087\0server/leaf.ts\0client/leaf.js\0");
  assertEquals(changes, [
    { status: "R087", path: "server/leaf.ts", removed: true },
    { status: "R087", path: "client/leaf.js", removed: false },
  ]);
  const selected = selectChecks(changes, fixture());
  assertEquals(selected.serverTests, ["tests/leaf_test.ts"]);
  assertEquals(selected.clientTests, ["client/leaf.js"]);
  assertEquals(
    selectChecks(parseNameStatus("D\0client/gone.js\0"), fixture()).clientTests,
    ["client/gone.js"],
  );
  assertEquals(parseNameStatus(""), []);
  for (const text of ["bogus\0a.ts\0", "R100\0one\0", "M\0", "M\0\0"]) {
    assertThrows(() => parseNameStatus(text));
  }
});

Deno.test("select-checks: missing import analysis is a selection error", () => {
  const context = fixture();
  delete context.imports["tests/leaf_test.ts"];
  assertThrows(
    () => selectChecks([modified("server/leaf.ts")], context),
    Error,
    "missing direct imports",
  );
});

Deno.test("select-checks: malformed selections and CI-only gates fail closed", () => {
  const valid = select("server/leaf.ts");
  validateSelection(valid);
  for (
    const patch of [
      { version: 2 },
      { browser: "false" },
      { browser: true },
      { gates: [] },
      { gates: [...valid.gates, "build", "cold-load"] },
      { gates: [...valid.gates, "native"] },
      { gates: [...valid.gates, "unit-controls"] },
      { serverTests: [] },
      { serverTests: "all" },
      { clientTests: null },
      { timingTests: ["tests/timing/slow_test.ts"] },
      { contractTests: ["one\ntwo"] },
      { browserCases: ["alpha"] },
      { reasons: [] },
      { reasons: [{}] },
    ]
  ) {
    assertThrows(
      () => validateSelection({ ...valid, ...patch }),
      Error,
      "invalid selection",
    );
  }
});

Deno.test("select-checks: Deno resolves direct imports, ignores literal launch paths and fails on missing modules", async () => {
  const root = await Deno.makeTempDir({ prefix: "selector-imports-" });
  try {
    await Deno.mkdir(`${root}/tests`);
    await Deno.mkdir(`${root}/server`);
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({ imports: { "@leaf": "./server/leaf.ts" } }),
    );
    await Deno.writeTextFile(
      `${root}/server/leaf.ts`,
      "export const leaf = 1;\n",
    );
    await Deno.writeTextFile(`${root}/server/main.ts`, 'import "./leaf.ts";\n');
    await Deno.writeTextFile(
      `${root}/tests/direct_test.ts`,
      'import "@leaf";\n',
    );
    await Deno.writeTextFile(
      `${root}/tests/boot_test.ts`,
      'const entry = new URL("../server/main.ts", import.meta.url);\n',
    );
    await Deno.writeTextFile(
      `${root}/tests/transitive_test.ts`,
      'import "../server/main.ts";\n',
    );
    const files = [
      "tests/direct_test.ts",
      "tests/boot_test.ts",
      "tests/transitive_test.ts",
      "server/leaf.ts",
      "server/main.ts",
    ];
    const changes = [modified("server/leaf.ts")];
    const context = await loadContext(root, files, changes);
    assertEquals(selectChecks(changes, context).serverTests, [
      "tests/direct_test.ts",
    ]);
    await Deno.writeTextFile(
      `${root}/tests/direct_test.ts`,
      'import "../missing.ts";\n',
    );
    await assertRejects(() => loadContext(root, files, changes), Error);
    // Static-only changes do not need import analysis at all.
    assertEquals(
      (await loadContext(root, files, [modified("deno.json")])).imports,
      {},
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
