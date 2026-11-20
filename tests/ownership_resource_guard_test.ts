// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
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
  NATIVE_FINALIZER,
  RESOURCE_CORE,
  RESOURCE_ENGINE,
  RESOURCE_ENGINE_OWNERSHIP,
  RESOURCE_OWNERSHIP,
} from "./helpers/ownership_rules.ts";
import { assertUnowned } from "./ownership_review_test.ts";

const repositoryRoot = (moduleUrl: string | URL = import.meta.url) =>
  fromFileUrl(new URL("../", moduleUrl));

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
      analyzeOwnership(sources, RESOURCE_OWNERSHIP),
      LEGACY_OWNERSHIP,
      files,
    ),
    [],
  );
  assertEquals(LEGACY_OWNERSHIP.length, 90);
  assertEquals(LEGACY_OWNERSHIP.filter((entry) => entry.allowed).length, 0);
  assertEquals(
    LEGACY_OWNERSHIP.filter((entry) =>
      [RESOURCE_CORE, RESOURCE_ENGINE, NATIVE_FINALIZER].includes(entry.file)
    ),
    [],
  );
});
