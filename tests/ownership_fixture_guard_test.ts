// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  analyzeOwnership,
  inventoryErrors,
  repositorySources,
} from "./helpers/ownership_contract.ts";
import {
  FIXTURE_OWNERSHIP,
  FIXTURE_PILOT_OWNERSHIP,
  FIXTURE_SCOPE_ENGINE,
  PLUGIN_FIXTURE_ENGINE,
  registeredOwnership,
} from "./helpers/ownership_rules.ts";
import { LEGACY_OWNERSHIP } from "./helpers/ownership_legacy.ts";
import { withPluginFixture } from "./helpers/plugin_fixture.ts";

const repositoryRoot = (moduleUrl: string | URL = import.meta.url) =>
  fromFileUrl(new URL("../", moduleUrl));

for (
  const text of [
    "Promise.withResolvers()",
    "const Deferred = Promise; Deferred.withResolvers()",
    "const {withResolvers: gate} = Promise; gate()",
    'Promise["withResolvers"]()',
    "new Promise(() => {})",
    "const scope={admit:f=>f()}; scope.admit(()=>Promise.withResolvers())",
  ]
) {
  Deno.test(`P03 coordination: bare or aliased gate is not owned: ${text}`, () => {
    const sites = registeredOwnership([{
      file: "tests/plugin_fixture_cleanup_test.ts",
      text,
    }]);
    assert(sites.some((site) => site.capability.startsWith("Promise.")));
  });
}

Deno.test("P03 review: encoded checkout roots reach registered fixture owners", async () => {
  await withPluginFixture(async (fixture) => {
    const link = join(fixture.root, "checkout space % #");
    await Deno.symlink(repositoryRoot(), link, { type: "dir" });
    const url = toFileUrl(join(link, "tests/ownership_fixture_guard_test.ts"));
    const root = repositoryRoot(url);
    assertEquals(root, link + "/");
    const sources = await repositorySources(root);
    const files = new Set(sources.map((source) => source.file));
    assert(files.has(FIXTURE_SCOPE_ENGINE));
    assert(files.has(PLUGIN_FIXTURE_ENGINE));
    assertEquals(
      inventoryErrors(registeredOwnership(sources), LEGACY_OWNERSHIP, files),
      [],
    );
  });
});

Deno.test("P03 registration: product cannot import test fixture facades", () => {
  for (
    const module of [
      "tests/helpers/fixture_scope.ts",
      "tests/helpers/plugin_fixture.ts",
      "tests/helpers/plugin_operations_fixture.ts",
    ]
  ) {
    assertUnowned(
      registeredOwnership([{
        file: "server/ordinary.ts",
        text: 'import * as fixture from "fixture";',
        imports: { fixture: module },
      }]),
      `module:${module}`,
    );
  }
});
import { assertUnowned } from "./ownership_review_test.ts";

for (const module of [FIXTURE_SCOPE_ENGINE, PLUGIN_FIXTURE_ENGINE]) {
  for (
    const text of [
      'import {createFixtureScope as create} from "private";',
      'import * as owner from "private"; owner[input()]();',
      'import owner from "private";',
      'import "private";',
      'import {} from "private";',
      'export {} from "private";',
      'export * from "private";',
      'export * as owner from "private";',
      'export {createFixtureScope as create} from "private";',
      'await import("private");',
      'import owner = require("private");',
    ]
  ) {
    Deno.test(`P03 registration: ${module} rejects ${text}`, () => {
      const sites = analyzeOwnership([{
        file: "tests/ordinary.cts",
        text,
        imports: { private: module },
      }], FIXTURE_OWNERSHIP);
      assertUnowned(sites, `module:${module}`);
      assertEquals(sites.map((site) => site.source), ['"private"']);
    });
  }
}
for (const prefix of [";", "function local() {};"]) {
  for (
    const expression of [
      "Deno.makeTempDir()",
      "Deno.makeTempFileSync()",
      "const runtime=Deno; runtime.makeTempDir()",
      "const {makeTempDir:allocate}=Deno; allocate()",
      'const runtime=globalThis["Deno"]; runtime.makeTempDir()',
      "const box={allocate:Deno.makeTempDir}; box.allocate()",
    ]
  ) {
    Deno.test(`P03 registration: hidden acquisition ${prefix} ${expression}`, () => {
      const sites = analyzeOwnership([{
        file: "tests/helpers/plugin_fixture.ts",
        text: `${prefix} ${expression}`,
      }], FIXTURE_PILOT_OWNERSHIP);
      assert(sites.length > 0);
      assert(
        sites.every((site) => /^(Deno\.|globalThis\.)/.test(site.capability)),
      );
      assert(inventoryErrors(sites, [], new Set()).length > 0);
    });
  }
}
Deno.test("P03 registration: callback names and real facade imports cannot authorize a raw acquisition", () => {
  for (
    const text of [
      "const scope={acquire:f=>f()}; scope.acquire(()=>Deno.makeTempDir());",
      'import {fixtureScope} from "scope"; fixtureScope(scope=>scope.acquire(()=>Deno.makeTempDir()));',
      'import {fixtureScope} from "scope"; const raw=Deno.makeTempDir; fixtureScope(scope=>raw());',
    ]
  ) {
    assertUnowned(
      analyzeOwnership([{
        file: "tests/plugin_write_bases_test.ts",
        text,
        imports: { scope: "tests/helpers/fixture_scope.ts" },
      }], FIXTURE_PILOT_OWNERSHIP),
      "Deno.makeTempDir",
    );
  }
});
Deno.test("P03 registration: imported raw hub/manager/core reject at import sites regardless of aliases", () => {
  for (
    const module of [
      "server/hub/hub.ts",
      "tests/helpers/plugin_manager.ts",
      "shared/ownership.js",
    ]
  ) {
    assertUnowned(
      analyzeOwnership([{
        file: "tests/helpers/plugin_fixture.ts",
        text: 'import * as raw from "raw"; raw[input()]();',
        imports: { raw: module },
      }], FIXTURE_PILOT_OWNERSHIP),
      `module:${module}`,
    );
  }
});
Deno.test("P03 registration: re-export bridge is the violating producer, public callback remains public", () => {
  const sites = analyzeOwnership([
    {
      file: "shared/bridge.ts",
      text: 'export * from "private";',
      imports: { private: FIXTURE_SCOPE_ENGINE },
    },
    {
      file: "tests/case.ts",
      text: 'import {fixtureScope} from "bridge"; fixtureScope(body);',
      imports: { bridge: "shared/bridge.ts" },
    },
  ], FIXTURE_OWNERSHIP);
  assertEquals(sites.map((site) => site.file), ["shared/bridge.ts"]);
  assertEquals(
    analyzeOwnership([{
      file: "tests/case.ts",
      text: 'import {fixtureScope} from "public";',
      imports: { public: "tests/helpers/fixture_scope.ts" },
    }], FIXTURE_OWNERSHIP),
    [],
  );
  assertEquals(
    analyzeOwnership([{
      file: "tests/case.ts",
      text: 'import type {FixtureScope} from "private";',
      imports: { private: FIXTURE_SCOPE_ENGINE },
    }], FIXTURE_OWNERSHIP),
    [],
  );
});
Deno.test("P03 registration: actual registered modules and complete inventory", async () => {
  const sources = await repositorySources(repositoryRoot());
  const files = new Set(sources.map((source) => source.file));
  for (const module of [FIXTURE_SCOPE_ENGINE, PLUGIN_FIXTURE_ENGINE]) {
    assert(files.has(module));
  }
  assertEquals(
    inventoryErrors(registeredOwnership(sources), LEGACY_OWNERSHIP, files),
    [],
  );
  assertEquals(LEGACY_OWNERSHIP.filter((entry) => entry.allowed), []);
});
