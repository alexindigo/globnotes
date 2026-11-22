// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  discoverGuardModules,
  guardModules,
} from "../scripts/guard-modules.ts";
import { selectChecks, STATIC_GATES } from "../scripts/select-checks.ts";

// Frozen migration baseline, not a registration list: future guards need no edit.
const OLD_IMPORTS = [
  "tests/ownership_guard_test.ts",
  "tests/ownership_coverage_test.ts",
  "tests/ownership_resource_guard_test.ts",
  "tests/ownership_fixture_guard_test.ts",
  "tests/ownership_record_guard_test.ts",
  "tests/ownership_child_guard_test.ts",
  "tests/operation_lease_guard_test.ts",
  "tests/owned_publication_guard_test.ts",
  "tests/credential_secret_guard_test.ts",
  "tests/credential_proof_guard_test.ts",
  "tests/credential_transition_guard_test.ts",
  "tests/credential_preparation_guard_test.ts",
  "tests/owned_operation_guard_test.ts",
  "tests/owned_contenders_guard_test.ts",
  "tests/driver_phase_guard_test.ts",
  "tests/fixture_clock_guard_test.ts",
].sort();

Deno.test("guard discovery: exactly the old imports, without ordinary or runtime guard tests", async () => {
  assertEquals(
    guardModules([
      ...OLD_IMPORTS,
      "tests/ordinary_test.ts",
      "tests/access_commit_guards_test.ts",
      "server/not_a_guard_test.ts",
    ]),
    OLD_IMPORTS,
  );
  const discovered = await discoverGuardModules(
    fromFileUrl(new URL("../", import.meta.url)),
  );
  assertEquals(
    discovered.filter((file) => OLD_IMPORTS.includes(file)),
    OLD_IMPORTS,
  );
});

Deno.test("guard discovery: new nested guards register without editing a list", async () => {
  const root = await Deno.makeTempDir({ prefix: "contract-discovery-" });
  try {
    await Deno.mkdir(`${root}/tests/new`, { recursive: true });
    for (const name of ["nested_guard_test.ts", "ordinary_test.ts"]) {
      await Deno.writeTextFile(`${root}/tests/new/${name}`, "");
    }
    assertEquals(await discoverGuardModules(root), [
      "tests/new/nested_guard_test.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("guard discovery: a misnamed guard is reported, not silently skipped", () => {
  for (
    const name of [
      "new_guard.test.ts",
      "guard_new_test.ts",
      "new-guard-test.ts",
    ]
  ) {
    assertThrows(
      () => guardModules([`tests/${name}`]),
      Error,
      `guard module must use *_guard_test.ts: tests/${name}`,
    );
  }
});

Deno.test("guard discovery: unchanged guards are always-on and a changed guard still selects itself", () => {
  const guard = "tests/new/nested_guard_test.ts";
  const files = [
    "tests/test_isolation_contract_test.ts",
    "tests/devcontainer_caps_test.ts",
    guard,
  ];
  const context = {
    files,
    imports: Object.fromEntries(files.map((f) => [f, []])),
  };
  assertEquals(selectChecks([], context).contractTests, files);
  const selected = selectChecks([
    { status: "M", path: guard, removed: false },
  ], context);
  assertEquals(selected.contractTests, files);
  assertEquals(selected.serverTests, [guard]);
  assertEquals(selected.gates, [...STATIC_GATES, "server"]);
});
