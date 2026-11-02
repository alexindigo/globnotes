// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The commit check's selection rules (scripts/select-checks.ts), one fixture
 * case per rule. The fixture is a small synthetic tree; the hook trials in
 * docs/testing.md exercise the real one.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type Change,
  type Context,
  type Gate,
  type ModuleRefs,
  parseNameStatus,
  scanModule,
  selectChecks,
  type Selection,
  STATIC_GATES,
} from "../scripts/select-checks.ts";

const E2E = "client/tests/e2e/";

const FILES = [
  ".devcontainer/run.sh",
  "LICENSE",
  "README.md",
  "deno.json",
  "docs/guide.md",
  "plugins/sample/plugin.js",
  "server/main.ts",
  "server/notes/store.ts",
  "server/search/index.ts",
  "server/unused.ts",
  "shared/uuid.ts",
  "tests/devcontainer_caps_test.ts",
  "tests/helpers/boot.ts",
  "tests/notes_test.ts",
  "tests/server_test.ts",
  "tests/notice_test.ts",
  "tests/test_isolation_contract_test.ts",
  "tests/timing/helper.ts",
  "tests/timing/slow_test.ts",
  "client/views/Home.vue",
  "client/tests/setup.js",
  "client/tests/home.test.js",
  `${E2E}legacy-native-suite.mjs`,
  `${E2E}test-outcomes.mjs`,
  `${E2E}fixture.mjs`,
  `${E2E}alpha.mjs`,
  `${E2E}beta.mjs`,
  `${E2E}native-result-controls.mjs`,
  `${E2E}orphan.mjs`,
  `${E2E}helper.test.js`,
  `${E2E}data.json`,
];

const refs = (
  imports: string[] = [],
  literals: string[] = [],
  extra: Partial<ModuleRefs> = {},
): ModuleRefs => ({
  imports,
  literals,
  loaders: [],
  unknownDynamic: 0,
  ...extra,
});

function fixture(overrides: Partial<Context> = {}): Context {
  return {
    files: FILES,
    refs: {
      "server/main.ts": refs(["server/search/index.ts"]),
      "server/search/index.ts": refs(["server/notes/store.ts"]),
      "server/notes/store.ts": refs(["shared/uuid.ts"]),
      "server/unused.ts": refs(),
      "shared/uuid.ts": refs(),
      // The launcher names the server entry and runs it in the repo root.
      "tests/helpers/boot.ts": refs([], ["server/main.ts", ""]),
      "tests/server_test.ts": refs(["tests/helpers/boot.ts"]),
      "tests/notes_test.ts": refs(["server/notes/store.ts"]),
      "tests/notice_test.ts": refs([], ["README.md"]),
      "tests/devcontainer_caps_test.ts": refs([], [".devcontainer/"]),
      "tests/test_isolation_contract_test.ts": refs([], [""]),
      "tests/timing/slow_test.ts": refs(["tests/timing/helper.ts"]),
      "tests/timing/helper.ts": refs(),
      [`${E2E}legacy-native-suite.mjs`]: refs([`${E2E}test-outcomes.mjs`]),
      [`${E2E}test-outcomes.mjs`]: refs(),
      [`${E2E}fixture.mjs`]: refs([`${E2E}test-outcomes.mjs`]),
      [`${E2E}alpha.mjs`]: refs([`${E2E}fixture.mjs`]),
      [`${E2E}beta.mjs`]: refs([`${E2E}test-outcomes.mjs`]),
      [`${E2E}native-result-controls.mjs`]: refs([`${E2E}fixture.mjs`]),
      [`${E2E}orphan.mjs`]: refs(),
      [`${E2E}helper.test.js`]: refs([`${E2E}orphan.mjs`]),
      "plugins/sample/plugin.js": refs(),
    },
    cases: {
      all: ["alpha", "beta-one", "beta-two"],
      drivers: {
        alpha: `${E2E}alpha.mjs`,
        "beta-one": `${E2E}beta.mjs`,
        "beta-two": `${E2E}beta.mjs`,
      },
      fileCases: {
        [`${E2E}legacy-native-suite.mjs`]: ["alpha", "beta-one", "beta-two"],
        [`${E2E}test-outcomes.mjs`]: ["alpha", "beta-one", "beta-two"],
        [`${E2E}alpha.mjs`]: ["alpha"],
        [`${E2E}beta.mjs`]: ["beta-one", "beta-two"],
      },
      sharedFiles: [`${E2E}legacy-native-suite.mjs`, `${E2E}test-outcomes.mjs`],
    },
    clientSetup: ["client/tests/setup.js"],
    ...overrides,
  };
}

const modified = (path: string): Change => ({
  status: "M",
  path,
  removed: false,
});
const select = (changes: Change[], context = fixture()): Selection =>
  selectChecks(changes, context);
const NON_BROWSER: Gate[] = [
  ...STATIC_GATES,
  "server",
  "client",
  "build",
  "cold-load",
  "unit-controls",
];

Deno.test("select-checks: name-status input, renames give both paths", () => {
  assertEquals(
    parseNameStatus(
      "M\0a.ts\0R087\0old/b.ts\0new/b.ts\0D\0gone.ts\0C100\0c.ts\0d.ts\0",
    ),
    [
      { status: "M", path: "a.ts", removed: false },
      { status: "R087", path: "old/b.ts", removed: true },
      { status: "R087", path: "new/b.ts", removed: false },
      { status: "D", path: "gone.ts", removed: true },
      { status: "C100", path: "c.ts", removed: false },
      { status: "C100", path: "d.ts", removed: false },
    ],
  );
  assertEquals(parseNameStatus(""), []);
  assertThrows(() => parseNameStatus("bogus\0a.ts\0"));
  assertThrows(() => parseNameStatus("R100\0only-one\0"));
});

Deno.test("select-checks: row 1, every change runs the static gates and contract tests", () => {
  for (
    const change of [[], [modified("server/unused.ts")], [modified("LICENSE")]]
  ) {
    const selection = select(change);
    for (const gate of STATIC_GATES) {
      assert(selection.gates.includes(gate), gate);
    }
    assertEquals(selection.contractTests, [
      "tests/test_isolation_contract_test.ts",
      "tests/devcontainer_caps_test.ts",
    ]);
  }
  // Only the contract tests the tree has.
  const without = fixture({
    files: FILES.filter((file) => file !== "tests/devcontainer_caps_test.ts"),
  });
  assertEquals(select([], without).contractTests, [
    "tests/test_isolation_contract_test.ts",
  ]);
});

Deno.test("select-checks: row 2, server tests whose dependencies contain the path", () => {
  const leaf = select([modified("server/notes/store.ts")]);
  assertEquals(leaf.gates, [...STATIC_GATES, "server"]);
  // Its importer, plus every test that runs the server through the launcher
  // and the whole-tree scan (both name the repository root).
  assertEquals(leaf.serverTests, [
    "tests/notes_test.ts",
    "tests/server_test.ts",
    "tests/test_isolation_contract_test.ts",
  ]);
  assertEquals(leaf.browser, false);
  // A changed test selects itself.
  assertEquals(select([modified("tests/notes_test.ts")]).serverTests, [
    "tests/notes_test.ts",
    "tests/server_test.ts",
    "tests/test_isolation_contract_test.ts",
  ]);
  // A module no test reaches still gets the static gates (and the root-level
  // launcher tests, which can load it from the tree).
  assertEquals(select([modified("server/unused.ts")]).serverTests, [
    "tests/server_test.ts",
    "tests/test_isolation_contract_test.ts",
  ]);
});

Deno.test("select-checks: row 2, unknown dependencies select more", () => {
  // No graph: the whole server suite.
  assertEquals(
    select([modified("server/unused.ts")], fixture({ refs: null })).serverTests,
    "all",
  );
  // An unclassified dynamic import makes its test depend on everything.
  const context = fixture();
  context.refs!["tests/notice_test.ts"] = refs([], [], { unknownDynamic: 1 });
  assert(
    (select([modified("server/unused.ts")], context).serverTests as string[])
      .includes("tests/notice_test.ts"),
  );
  // A loader directory makes its modules dependencies.
  const loader = fixture();
  loader.refs!["tests/notes_test.ts"] = refs([], ["server/"], {
    loaders: ["server/"],
  });
  assert(
    (select([modified("server/unused.ts")], loader).serverTests as string[])
      .includes("tests/notes_test.ts"),
  );
});

Deno.test("select-checks: row 3, client paths select related client tests and the build", () => {
  const view = select([modified("client/views/Home.vue")]);
  assertEquals(view.gates, [
    ...STATIC_GATES,
    "client",
    "build",
    "cold-load",
    "unit-controls",
  ]);
  assertEquals(view.clientTests, ["client/views/Home.vue"]);
  assertEquals(view.serverTests, []);
  // shared/** is both server and client code.
  const shared = select([modified("shared/uuid.ts")]);
  assertEquals(shared.clientTests, ["shared/uuid.ts"]);
  assert((shared.serverTests as string[]).includes("tests/notes_test.ts"));
  assert(shared.gates.includes("build"));
  // The vitest setup file is loaded by every client test.
  assertEquals(select([modified("client/tests/setup.js")]).clientTests, "all");
});

Deno.test("select-checks: row 4, browser cases and meta gates that reach the path", () => {
  const driver = select([modified(`${E2E}beta.mjs`)]);
  assertEquals(driver.browserCases, ["beta-one", "beta-two"]);
  assertEquals(driver.browser, true);
  for (const gate of ["native", "native-controls", "build", "cold-load"]) {
    assert((driver.gates as string[]).includes(gate), gate);
  }
  assert(!driver.gates.includes("native-results"));
  // A harness module reached by one case and one meta gate.
  const harness = select([modified(`${E2E}fixture.mjs`)]);
  assertEquals(harness.browserCases, ["alpha"]);
  assert(harness.gates.includes("native-results"));
  // A shared harness file selects the whole browser suite.
  const shared = select([modified(`${E2E}test-outcomes.mjs`)]);
  assertEquals(shared.browserCases, "all");
  for (
    const gate of [
      "native",
      "native-results",
      "native-controls",
      "entrypoint-results",
      "unit-controls",
    ]
  ) {
    assert((shared.gates as string[]).includes(gate), gate);
  }
  // A client test under e2e is a vitest test, not a browser case.
  const test = select([modified(`${E2E}helper.test.js`)]);
  assertEquals(test.clientTests, [`${E2E}helper.test.js`]);
  assertEquals(test.browser, false);
  // A module no browser gate reaches: no browser run, related client tests.
  const orphan = select([modified(`${E2E}orphan.mjs`)]);
  assertEquals(orphan.browser, false);
  assertEquals(orphan.clientTests, [`${E2E}orphan.mjs`]);
  // An unmapped non-module file, or no case map: the whole browser suite.
  assertEquals(select([modified(`${E2E}data.json`)]).browserCases, "all");
  assertEquals(
    select([modified(`${E2E}beta.mjs`)], fixture({ cases: null })).browserCases,
    "all",
  );
});

Deno.test("select-checks: row 5, shared inputs select every non-browser check", () => {
  const config = select([modified("deno.json")]);
  assertEquals(config.gates, NON_BROWSER);
  assertEquals(config.serverTests, "all");
  assertEquals(config.clientTests, "all");
  assertEquals(config.browser, false);
  assertEquals(config.timingTests, []);
  const devcontainer = select([modified(".devcontainer/run.sh")]);
  assertEquals(devcontainer.browserCases, "all");
  assertEquals(devcontainer.serverTests, "all");
  assertEquals(devcontainer.browser, true);
});

Deno.test("select-checks: row 6, timing tests run only for their own changes", () => {
  const timing = select([modified("tests/timing/slow_test.ts")]);
  assertEquals(timing.gates, [...STATIC_GATES, "timing"]);
  assertEquals(timing.timingTests, ["tests/timing/slow_test.ts"]);
  assertEquals(timing.serverTests, []);
  assertEquals(select([modified("tests/timing/helper.ts")]).timingTests, "all");
  // Server changes never select them; the selection says so.
  const server = select([modified("server/notes/store.ts")]);
  assertEquals(server.timingTests, []);
  assert(
    server.reasons.some((reason) =>
      reason.selects.startsWith("timing tests run")
    ),
  );
});

Deno.test("select-checks: row 7, docs select the static gates", () => {
  for (const path of ["docs/guide.md", "client/views/notes.md"]) {
    const docs = select([modified(path)]);
    assertEquals(docs.gates, STATIC_GATES);
  }
  // Unless a test names that very file.
  const named = select([modified("README.md")]);
  assertEquals(named.serverTests, ["tests/notice_test.ts"]);
});

Deno.test("select-checks: row 8, unclassified paths select the shared-input set", () => {
  for (
    const path of ["LICENSE", "plugins/sample/plugin.js", "new-top-level.txt"]
  ) {
    const selection = select([modified(path)]);
    assertEquals(selection.serverTests, "all", path);
    assertEquals(selection.clientTests, "all", path);
    assertEquals(selection.gates, NON_BROWSER, path);
  }
});

Deno.test("select-checks: row 9, renames and deletions classify both paths", () => {
  const rename = select(parseNameStatus(
    "R100\0server/notes/store.ts\0client/notes/store.js\0",
  ));
  // The removed server path cannot be traced in the snapshot: everything.
  assertEquals(rename.serverTests, "all");
  assertEquals(rename.clientTests, ["client/notes/store.js"]);
  const deletion = select(parseNameStatus("D\0client/views/Gone.vue\0"));
  assertEquals(deletion.clientTests, "all");
  const browser = select(parseNameStatus(`D\0${E2E}gamma.mjs\0`));
  assertEquals(browser.browserCases, "all");
  const docs = select(parseNameStatus("R100\0docs/a.md\0docs/b.md\0"));
  assertEquals(docs.gates, STATIC_GATES);
});

Deno.test("select-checks: literal paths, dynamic sites and loaders", () => {
  const tracked = new Set([
    "server/main.ts",
    "server/api/endpoints/#id/get.ts",
    "tests/helpers/boot.ts",
  ]);
  const directories = new Set([
    "server",
    "server/api",
    "server/api/endpoints",
    "server/api/endpoints/#id",
    "tests",
    "tests/helpers",
  ]);
  const scanned = scanModule(
    "tests/helpers/boot.ts",
    [
      `const MAIN = new URL("../../server/main.ts", import.meta.url);`,
      `const ROOT = new URL("../../", import.meta.url);`,
      `const HANDLER = "../../server/api/endpoints/%23id/get.ts";`,
      `const ROUTES = new URL("../../server/api/endpoints/", import.meta.url);`,
      `const NAMED = "server/main.ts";`,
      `const SKIP = "../../missing.ts" + "@std/assert";`,
      `await import(specifier);`,
    ].join("\n"),
    tracked,
    directories,
  );
  assertEquals(scanned.literals, [
    "",
    "server/api/endpoints/",
    "server/api/endpoints/#id/get.ts",
    "server/main.ts",
  ]);
  assertEquals(scanned.loaders, ["server/api/endpoints/"]);
  assertEquals(scanned.unknownDynamic, 1);
  // Literal dynamic imports are graph edges, not unknown sites.
  assertEquals(
    scanModule(
      "tests/a_test.ts",
      `await import(\n  new URL(\n    "../server/main.ts",\n    import.meta.url,\n  ).href\n);\nawait import("../server/main.ts");`,
      tracked,
      directories,
    ).unknownDynamic,
    0,
  );
});
