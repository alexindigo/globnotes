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
  AUTHORITY_PILOT,
  GUARDED_SINK_OWNER,
  OPERATION_LEASE_OWNER,
  OPERATION_OWNERSHIP,
  registeredOwnership,
} from "./helpers/ownership_rules.ts";

const input = (text: string, file = "server/bypass.cts"): SourceModule => ({
  file,
  text,
  imports: { private: GUARDED_SINK_OWNER, lease: OPERATION_LEASE_OWNER },
});
for (
  const [specifier, module] of [["private", GUARDED_SINK_OWNER], [
    "lease",
    OPERATION_LEASE_OWNER,
  ]]
) {
  Deno.test(`P05 registration: every runtime import of ${module} rejects at its root import site`, () => {
    for (
      const code of [
        `import {bindGuardedSink as bind} from "${specifier}";`,
        `import * as raw from "${specifier}";`,
        `import raw from "${specifier}";`,
        `import "${specifier}";`,
        `import {} from "${specifier}";`,
        `export {} from "${specifier}";`,
        `export {anything as raw} from "${specifier}";`,
        `export * from "${specifier}";`,
        `export * as raw from "${specifier}";`,
        `await import("${specifier}");`,
        `import raw = require("${specifier}");`,
      ]
    ) {
      const sites = analyzeOwnership([input(code)], OPERATION_OWNERSHIP);
      assertEquals(sites.map((s) => s.capability), [`module:${module}`]);
      assertEquals(sites.map((s) => s.source), [`"${specifier}"`]);
      assert(inventoryErrors(sites, [], new Set()).length > 0);
      assertEquals(
        analyzeOwnership([input(code, AUTHORITY_PILOT)], OPERATION_OWNERSHIP),
        [],
      );
    }
    assertEquals(
      analyzeOwnership([
        input(`import type {OperationLease} from "${specifier}";`),
      ], OPERATION_OWNERSHIP),
      [],
    );
  });
}

Deno.test("P05 registration: alias/re-export producer cannot launder a private sink; public values need no flow inference", () => {
  const sources = [
    input(
      'export {bindGuardedSink as bind} from "private";',
      "shared/bridge.ts",
    ),
    {
      file: "server/consumer.ts",
      text: 'import {bind} from "bridge"; bind(lease,"live",effect);',
      imports: { bridge: "shared/bridge.ts" },
    },
  ];
  const sites = analyzeOwnership(sources, OPERATION_OWNERSHIP);
  assertEquals(sites.map((s) => [s.file, s.capability]), [[
    "shared/bridge.ts",
    `module:${GUARDED_SINK_OWNER}`,
  ]]);
  const mixed = input(
    'import {createOperationLease} from "lease"; import "private";',
    "server/auth/middleware.ts",
  );
  assertEquals(
    analyzeOwnership([mixed], OPERATION_OWNERSHIP).map((s) => s.capability),
    [`module:${GUARDED_SINK_OWNER}`],
  );
});

Deno.test("P05 registration: exact consumers, duplicate violations and false closure remain enforced", () => {
  const sites = analyzeOwnership(
    [input('import "private";')],
    OPERATION_OWNERSHIP,
  );
  const entries = sites.map((site) => ({
    ...site,
    family: "operation-lease-pilot",
    replacement: "P05",
    consumers: ["tests/operation_lease_test.ts"],
  }));
  const files = new Set(entries[0].consumers);
  assertEquals(inventoryErrors(sites, entries, files), []);
  assert(
    inventoryErrors([...sites, ...sites], entries, files).some((e) =>
      e.startsWith("unowned capability:")
    ),
  );
  assert(
    familyInventoryErrors(entries, OWNERSHIP_FAMILIES, files, new Set()).some(
      (e) => e.startsWith("residual inventory declared closed:"),
    ),
  );
  assert(
    familyInventoryErrors(
      [],
      { "operation-lease-pilot": OWNERSHIP_FAMILIES["operation-lease-pilot"] },
      new Set(),
      new Set(),
    ).some((e) => e.startsWith("lost operation-lease-pilot consumer:")),
  );
});

Deno.test("P05 registration: actual private modules and exact owners exist, with no stale owner allowances", async () => {
  const sources = await repositorySources(
    fromFileUrl(new URL("../", import.meta.url)),
  );
  const files = new Set(sources.map((s) => s.file));
  for (const module of [OPERATION_LEASE_OWNER, GUARDED_SINK_OWNER]) {
    assert(files.has(module));
    for (const owner of OPERATION_OWNERSHIP.modules[module]) {
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
  assertEquals(registeredOwnership(sources).length, LEGACY_OWNERSHIP.length);
  assertEquals(LEGACY_OWNERSHIP.filter((e) => e.allowed).length, 0);
  assertEquals(
    LEGACY_OWNERSHIP.filter((e) => e.family === "operation-lease-pilot"),
    [],
  );
});
