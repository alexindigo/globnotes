// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  analyzeOwnership,
  inventoryErrors,
  repositorySources,
} from "./helpers/ownership_contract.ts";
import {
  BOOT_OWNER,
  BOOT_OWNERSHIP,
  CHILD_OWNERSHIP,
  RAW_PROCESS,
  registeredOwnership,
} from "./helpers/ownership_rules.ts";
import { LEGACY_OWNERSHIP } from "./helpers/ownership_legacy.ts";
import { assertUnowned } from "./ownership_review_test.ts";
import { withPluginFixture } from "./helpers/plugin_fixture.ts";

const repositoryRoot = (moduleUrl: string | URL = import.meta.url) =>
  fromFileUrl(new URL("../", moduleUrl));

Deno.test("P12 review: encoded checkout roots reach actual child owners", async () => {
  await withPluginFixture(async (fixture) => {
    const link = join(fixture.root, "checkout space % #");
    await Deno.symlink(repositoryRoot(), link, { type: "dir" });
    const url = toFileUrl(join(link, "tests/ownership_child_guard_test.ts"));
    const root = repositoryRoot(url);
    assertEquals(root, link + "/");
    const sources = await repositorySources(root);
    const files = new Set(sources.map((source) => source.file));
    assert(files.has(BOOT_OWNER));
    assert(files.has("tests/helpers/owned_child.ts"));
    assertEquals(
      inventoryErrors(registeredOwnership(sources), LEGACY_OWNERSHIP, files),
      [],
    );
  });
});

for (
  const file of [
    "tests/child-control.cts",
    "client/tests/e2e/child-control.mjs",
  ]
) {
  for (
    const text of [
      'import {command as launch} from "raw"; launch("true").spawn();',
      'import {command as launch} from "raw"; opaque(launch("true").spawn);',
      'import * as p from "raw"; const {spawn:start}=p.command("true"); start();',
      'import {command} from "raw"; const child=command("true").spawn(); child.kill("SIGTERM");',
      'import {command} from "raw"; const child=command("true").spawn(); const key="ki"+"ll"; child[key]("SIGTERM");',
      'import {command} from "raw"; const {kill:stop}=command("true").spawn(); stop("SIGTERM");',
      'import "raw";',
      'import {} from "raw";',
      'export {} from "raw";',
      'export * from "raw";',
      'export * as launcher from "raw";',
      'await import("raw");',
    ]
  ) {
    Deno.test(`P12 registration: ${file} rejects raw launcher acquisition ${text}`, () => {
      const sites = analyzeOwnership([{
        file,
        text,
        imports: { raw: RAW_PROCESS },
      }], CHILD_OWNERSHIP);
      assertUnowned(sites, `module:${RAW_PROCESS}`);
      assertEquals(sites.map((site) => site.source), ['"raw"']);
    });
  }
}
Deno.test("P12 registration: private launcher import-equals rejects", () => {
  assertUnowned(
    analyzeOwnership([{
      file: "tests/control.cts",
      text: 'import raw = require("raw");',
      imports: { raw: RAW_PROCESS },
    }], CHILD_OWNERSHIP),
    `module:${RAW_PROCESS}`,
  );
});
Deno.test("P12 registration: bridge rejects its raw producer, not downstream spawn/kill aliases", () => {
  const sites = analyzeOwnership([{
    file: "shared/bridge.mjs",
    text: 'export {command as launch} from "raw";',
    imports: { raw: RAW_PROCESS },
  }, {
    file: "tests/case.mjs",
    text:
      'import {launch} from "bridge"; const child=launch("true").spawn(); child.kill("SIGTERM");',
    imports: { bridge: "shared/bridge.mjs" },
  }], CHILD_OWNERSHIP);
  assertEquals(sites.map((site) => site.file), ["shared/bridge.mjs"]);
});
for (
  const [text, capability] of [
    ["setTimeout(()=>{},5000);", "setTimeout.*"],
    [
      'const timer=globalThis["setTimeout"]; timer(()=>{},5000);',
      "globalThis.*",
    ],
    ["const timer=globalThis.setTimeout;", "globalThis.setTimeout"],
    ['Deno.truncate("control",0);', "Deno.truncate"],
    ['Deno.futureFilesystemEffect("control");', "Deno.futureFilesystemEffect"],
    ["Deno.stdin;", "Deno.stdin"],
    ['Deno.kill(1,"SIGTERM");', "Deno.kill"],
    ["const {kill:stop}=Deno;", "Deno.*"],
    ['; new Deno.Command("true");', "Deno.Command"],
    ['function local() {}; new Deno.Command("true");', "Deno.Command"],
    [
      'import {command} from "raw"; command("true").spawn();',
      `module:${RAW_PROCESS}`,
    ],
  ]
) {
  Deno.test(`P12 registration: boot rejects bypass ${text}`, () =>
    assertUnowned(
      analyzeOwnership([{
        file: BOOT_OWNER,
        text,
        imports: { raw: RAW_PROCESS },
      }], BOOT_OWNERSHIP),
      capability,
    ));
}

Deno.test("P12 registration: public process facade exposes values, never raw command construction", async () => {
  const values = await import("./helpers/process_values.ts");
  assertEquals(Object.keys(values).sort(), [
    "DENO",
    "childEnvironment",
    "workerCommandDenialProbeSource",
  ]);
  assertEquals(
    analyzeOwnership([{
      file: "tests/ordinary.ts",
      text:
        'import {DENO} from "public"; import type {ChildOptions} from "raw";',
      imports: { public: "tests/helpers/process_values.ts", raw: RAW_PROCESS },
    }], CHILD_OWNERSHIP),
    [],
  );
});
Deno.test("P12 registration: complete root/import inventory rejects duplicated references without permanent allowances", async () => {
  const sources = await repositorySources(repositoryRoot()),
    sites = registeredOwnership(sources),
    files = new Set(sources.map((source) => source.file));
  assertEquals(inventoryErrors(sites, LEGACY_OWNERSHIP, files), []);
  assertEquals(LEGACY_OWNERSHIP.filter((entry) => entry.allowed), []);
  const children = LEGACY_OWNERSHIP.filter((entry) =>
    entry.capability === `module:${RAW_PROCESS}` ||
    entry.capability === "Deno.Command"
  );
  assertEquals(
    [...new Set(children.map((entry) => entry.file.split("/")[0]))].sort(),
    ["client", "scripts", "tests"],
  );
  const entry = children[0];
  assertEquals(inventoryErrors([...sites, entry], LEGACY_OWNERSHIP, files), [
    `unowned capability: ${entry.file}:${entry.line}: ${entry.capability}: ${entry.source}`,
  ]);
  assertEquals(children.filter((entry) => entry.file === BOOT_OWNER), []);
});
