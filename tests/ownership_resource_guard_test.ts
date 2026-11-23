// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join, relative, toFileUrl } from "@std/path";
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
  BROWSER_OPERATION_CONTRACT,
  BROWSER_OPERATION_OWNER,
  BROWSER_OPERATION_PILOT,
  NATIVE_FINALIZER,
  registeredOwnership,
  RESOURCE_CORE,
  RESOURCE_ENGINE,
  RESOURCE_ENGINE_OWNERSHIP,
  RESOURCE_OWNERSHIP,
} from "./helpers/ownership_rules.ts";
import { assertUnowned } from "./ownership_review_test.ts";

const repositoryRoot = (moduleUrl: string | URL = import.meta.url) =>
  fromFileUrl(new URL("../", moduleUrl));

Deno.test("G5 registration: the browser pilot cannot bypass custody or browser capability owners", () => {
  const inputs = [
    'import {createOwnershipScope as raw} from "facade";',
    'export * from "facade";',
    'await import("facade");',
    "const raw = fetch;",
    'navigator["credentials"];',
    'localStorage.getItem("credentials");',
    'sessionStorage.getItem("credentials");',
    "crypto.subtle;",
    'import "engine";',
    "Promise.withResolvers();",
    "window.crypto;",
    "globalThis.crypto;",
  ];
  const expected = [
    `module:${RESOURCE_CORE}`,
    `module:${RESOURCE_CORE}`,
    `module:${RESOURCE_CORE}`,
    "fetch.*",
    "navigator.*",
    "localStorage.getItem",
    "sessionStorage.getItem",
    "crypto.subtle",
    `module:${RESOURCE_ENGINE}`,
    "Promise.withResolvers",
    "window.crypto",
    "globalThis.crypto",
  ];
  for (const [index, text] of inputs.entries()) {
    const sites = registeredOwnership([input(text, BROWSER_OPERATION_PILOT)]);
    assertEquals(sites.map(({ file, capability }) => ({ file, capability })), [{
      file: BROWSER_OPERATION_PILOT,
      capability: expected[index],
    }]);
  }
  assertEquals(
    registeredOwnership([input(
      'import {createOwnershipScope} from "facade";',
      BROWSER_OPERATION_OWNER,
    )]),
    [],
  );
  assertEquals(
    registeredOwnership([
      input("new Promise(() => {});", BROWSER_OPERATION_OWNER),
    ]),
    [],
  );
  assertEquals(
    registeredOwnership([
      input("Promise.withResolvers();", BROWSER_OPERATION_OWNER),
    ]).map((site) => site.capability),
    ["Promise.withResolvers"],
  );
  assertEquals(
    registeredOwnership([
      input("new Promise(() => {});", BROWSER_OPERATION_PILOT),
    ]).map((site) => site.capability),
    ["Promise.*"],
  );
  const sources: SourceModule[] = [
    input('export * from "engine";', "client/raw-bridge.mjs"),
    {
      file: BROWSER_OPERATION_PILOT,
      text: 'import "bridge";',
      imports: { bridge: "client/raw-bridge.mjs" },
    },
  ];
  assertEquals(
    registeredOwnership(sources).map(({ file, capability }) => ({
      file,
      capability,
    })),
    [{
      file: "client/raw-bridge.mjs",
      capability: `module:${RESOURCE_ENGINE}`,
    }],
  );
});

Deno.test("G5 registration: actual browser owner, pilot and contract retain their exact capabilities", async () => {
  const root = repositoryRoot();
  // These are exact dependency declarations, not another source selector/parser.
  // Unknown imports reject through the existing unresolved-import rule. Plain
  // client modules are not roots of the server/native repository source graph.
  const dependencies: Record<string, string[]> = {
    [BROWSER_OPERATION_OWNER]: ["../shared/ownership.js"],
    [BROWSER_OPERATION_PILOT]: [
      "./api.js",
      "./bus/index.js",
      "./connectionLifetime.js",
      "./operationOwner.js",
      "./connectionLifetime.js",
    ],
    [BROWSER_OPERATION_CONTRACT]: [
      "vitest",
      "../operationOwner.js",
      "../../shared/ownership.js",
      "../../tests/helpers/owned_operation.ts",
    ],
  };
  const sources = await Promise.all(
    Object.entries(dependencies).map(async ([file, specifiers]) => ({
      file,
      text: await Deno.readTextFile(join(root, file)),
      imports: Object.fromEntries(
        specifiers.map((specifier) => [
          specifier,
          specifier.startsWith(".")
            ? relative(
              root,
              fromFileUrl(new URL(specifier, toFileUrl(join(root, file)))),
            )
            : import.meta.resolve(specifier),
        ]),
      ),
    })),
  );
  for (const source of sources) {
    assertEquals(
      analyzeOwnership([source], {
        roots: {},
        modules: Object.fromEntries(
          Object.values(source.imports).map((identity) => [identity, []]),
        ),
      }).map((site) => site.capability),
      dependencies[source.file].map((specifier) =>
        `module:${source.imports[specifier]}`
      ),
    );
  }
  // Exact remaining scheduler acquisitions predate G5 and belong to the later
  // browser migration. They grant no new owner or directory-wide allowance.
  const schedulingContext =
    "setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), now = () => Date.now(),";
  assertEquals(
    registeredOwnership(sources).map((
      { file, capability, source, context },
    ) => ({ file, capability, source, context })),
    [
      {
        file: BROWSER_OPERATION_PILOT,
        capability: "Date.now",
        source: "Date.now",
        context: schedulingContext,
      },
      {
        file: BROWSER_OPERATION_PILOT,
        capability: "setTimeout.*",
        source: "setTimeout",
        context: schedulingContext,
      },
    ],
  );
});

Deno.test("P02 review: encoded checkout roots reach the actual source owner", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ownership-path-" });
  const link = join(directory, "checkout space % #");
  try {
    await Deno.symlink(repositoryRoot(), link, { type: "dir" });
    const url = toFileUrl(join(link, "tests/ownership_resource_guard_test.ts"));
    const root = repositoryRoot(url);
    assertEquals(root, link + "/");
    const sources = await repositorySources(root);
    assert(sources.some((source) => source.file === RESOURCE_ENGINE));
    assert(sources.some((source) => source.file === NATIVE_FINALIZER));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// Synthetic fragments can include TS-only import forms; real JS owner fixtures
// name their actual file explicitly and must still pass compiler diagnostics.
const input = (
  text: string,
  file = "tests/resource-consumer.cts",
): SourceModule => ({
  file,
  text,
  imports: { engine: RESOURCE_ENGINE, facade: RESOURCE_CORE },
});

Deno.test("P02 registration: every raw-engine runtime import rejects at its resolved identity", () => {
  for (
    const text of [
      'import {createOwnershipScope as create} from "engine";',
      'import * as engine from "engine";',
      'import engine from "engine";',
      'import "engine";',
      'import {} from "engine";',
      'export {} from "engine";',
      'export {createOwnershipScope as create} from "engine";',
      'export * from "engine";',
      'export * as engine from "engine";',
      'await import("engine");',
      'import engine = require("engine");',
      'import {createOwnershipScope} from "facade"; import "engine";',
    ]
  ) {
    const sources = [input(text, "tests/consumer.cts")];
    const sites = analyzeOwnership(sources, RESOURCE_OWNERSHIP);
    assertUnowned(sites, `module:${RESOURCE_ENGINE}`);
    assertEquals(sites.map((site) => site.source), ['"engine"']);
    if (text.includes(" = require(")) {
      // The owner is JavaScript: permission cannot make TS-only syntax valid.
      assertThrows(
        () =>
          analyzeOwnership([input(text, RESOURCE_CORE)], RESOURCE_OWNERSHIP),
        Error,
        "ownership parse:",
      );
    } else {
      assertEquals(
        analyzeOwnership([input(text, RESOURCE_CORE)], RESOURCE_OWNERSHIP),
        [],
      );
    }
  }
  assertEquals(
    analyzeOwnership(
      [input('import type {OwnershipScope} from "engine";')],
      RESOURCE_OWNERSHIP,
    ),
    [],
  );
});

Deno.test("P02 registration: public facade aliases and re-exports stay public without following values", () => {
  for (
    const text of [
      'import {createOwnershipScope as make} from "facade"; const scope=make();',
      'import * as owner from "facade"; owner["createOwnershipScope"]();',
      'export {createOwnershipScope as make} from "facade";',
      'export * from "facade";',
    ]
  ) assertEquals(analyzeOwnership([input(text)], RESOURCE_OWNERSHIP), []);
  const sites = analyzeOwnership([
    input(
      'export {createOwnershipScope as make} from "engine";',
      "shared/bridge.js",
    ),
    {
      file: NATIVE_FINALIZER,
      text: 'import {make} from "bridge"; make();',
      imports: { bridge: "shared/bridge.js" },
    },
  ], RESOURCE_OWNERSHIP);
  assertUnowned(sites, `module:${RESOURCE_ENGINE}`);
  assertEquals(sites.map((site) => site.file), ["shared/bridge.js"]);
});

Deno.test("P02 registration: engine platform roots reject at references, not downstream aliases", () => {
  for (
    const [text, expected] of [
      ["Deno.readTextFile(path);", "Deno.readTextFile"],
      ["const runtime=Deno;", "Deno.*"],
      ["const {env}=process;", "process.*"],
      ["const timer=setTimeout;", "setTimeout.*"],
      ["globalThis.setTimeout(callback);", "globalThis.setTimeout"],
      ["fetch(url);", "fetch.*"],
      ["document.body;", "document.body"],
      ["navigator.userAgent;", "navigator.userAgent"],
      ["new Worker(url);", "Worker.*"],
    ]
  ) {
    assertUnowned(
      analyzeOwnership(
        [input(text, RESOURCE_ENGINE)],
        RESOURCE_ENGINE_OWNERSHIP,
      ),
      expected,
    );
  }
  assertEquals(
    analyzeOwnership([input(
      '// Deno.Command setTimeout\nconst text="fetch process"; function local(Deno) {return Deno.readTextFile();}',
      RESOURCE_ENGINE,
    )], RESOURCE_ENGINE_OWNERSHIP),
    [],
  );
});

Deno.test("P02 registration: exact inventory cannot authorize duplicated private-engine sites or false closure", () => {
  const sites = analyzeOwnership(
    [input('import "engine";')],
    RESOURCE_OWNERSHIP,
  );
  assertUnowned(sites, `module:${RESOURCE_ENGINE}`);
  const entries = sites.map((site) => ({
    ...site,
    family: "native-finalizer-pilot",
    replacement: "P02",
    consumers: ["tests/native_finalization_ownership_test.ts"],
  }));
  const files = new Set(entries[0].consumers);
  assertEquals(inventoryErrors(sites, entries, files), []);
  assert(
    inventoryErrors([...sites, sites[0]], entries, files).some((error) =>
      error.startsWith("unowned capability:")
    ),
  );
  assert(
    familyInventoryErrors(entries, OWNERSHIP_FAMILIES, files, new Set()).some(
      (error) => error.startsWith("residual inventory declared closed:"),
    ),
  );
  assert(
    familyInventoryErrors(
      [],
      {
        "native-finalizer-pilot": OWNERSHIP_FAMILIES["native-finalizer-pilot"],
      },
      new Set(),
      new Set(),
    ).some((error) =>
      error.startsWith("lost native-finalizer-pilot consumer:")
    ),
  );
});

Deno.test("P02 registration: actual engine, facade and native pilot retain their exact boundaries", async () => {
  const sources = await repositorySources(repositoryRoot());
  const files = new Set(sources.map((source) => source.file));
  for (const [module, owners] of Object.entries(RESOURCE_OWNERSHIP.modules)) {
    if (!module.startsWith("shared/")) continue;
    assert(files.has(module), `lost private module: ${module}`);
    for (const owner of owners) {
      assert(files.has(owner), `lost registered owner: ${owner}`);
    }
  }
  assert(files.has(NATIVE_FINALIZER));
  const engine = sources.find((source) => source.file === RESOURCE_ENGINE)!;
  assertEquals(
    Object.keys(engine.imports ?? {}),
    [],
    "the platform-free engine has no imported dependencies",
  );
  assertEquals(analyzeOwnership([engine], RESOURCE_ENGINE_OWNERSHIP), []);
  assertEquals(
    inventoryErrors(
      registeredOwnership(sources),
      LEGACY_OWNERSHIP,
      files,
    ),
    [],
  );
  assertEquals(LEGACY_OWNERSHIP.filter((entry) => entry.allowed).length, 0);
  assertEquals(
    LEGACY_OWNERSHIP.filter((entry) =>
      [RESOURCE_CORE, RESOURCE_ENGINE, NATIVE_FINALIZER].includes(entry.file)
    ),
    [],
  );
});
