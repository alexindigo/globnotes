// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  inventoryErrors,
  repositorySources,
} from "./helpers/ownership_contract.ts";
import { fixtureClockSites, LIVE_TOTP } from "./helpers/fixture_clock_rules.ts";
import { registeredOwnership } from "./helpers/ownership_rules.ts";
import { LEGACY_OWNERSHIP } from "./helpers/ownership_legacy.ts";

Deno.test("fixture clock guard: aliased re-exports cannot supply a hidden live clock", () => {
  const sites = registeredOwnership([
    { file: "shared/raw.ts", text: "export const live = Date.now;" },
    {
      file: "tests/bridge.mjs",
      text: "export {live as time} from './raw.ts';",
      imports: { "./raw.ts": "shared/raw.ts" },
    },
    {
      file: "tests/positive.ts",
      text: "import {time} from './bridge.mjs'; time();",
      imports: { "./bridge.mjs": "tests/bridge.mjs" },
    },
  ]);
  assertEquals(sites.map((site) => [site.file, site.capability]), [[
    "shared/raw.ts",
    "Date.now",
  ]]);
});

Deno.test("fixture clock guard: composition retains main's private launcher and construct-only Promise policy", () => {
  for (
    const file of [
      "tests/helpers/fixture_clock.ts",
      "tests/fixture_clock_ownership_test.ts",
    ]
  ) {
    const sites = registeredOwnership([{
      file,
      imports: { raw: "tests/helpers/process.ts" },
      text: 'import {command} from "raw"; const P = Promise; P.race([]);',
    }]);
    assertEquals(sites.map((site) => [site.file, site.capability]), [
      [file, "module:tests/helpers/process.ts"],
      [file, "Promise.*"],
    ]);
  }
  assertEquals(
    registeredOwnership([{
      file: "tests/helpers/fixture_clock.ts",
      text: "Promise.withResolvers();",
    }]),
    [],
  );
});

Deno.test("fixture clock guard: driver composition cannot recreate a private clock publication protocol", () => {
  const sites = registeredOwnership([{
    file: "tests/helpers/driver_fixture.ts",
    text: 'Deno.renameSync("observed.next", "observed.json");',
  }]);
  assertEquals(sites.map((site) => [site.file, site.capability]), [[
    "tests/helpers/driver_fixture.ts",
    "Deno.renameSync",
  ]]);
});

Deno.test("fixture clock guard: one exact legacy occurrence cannot cover a copied fallback", async () => {
  const sources = await repositorySources(
    fromFileUrl(new URL("../", import.meta.url)),
  );
  const file = "client/tests/e2e/native-totp-fixture.mjs";
  const original = sources.find((source) => source.file === file)!;
  const changed = sources.map((source) =>
    source.file === file
      ? { ...source, text: source.text + "\nDate.now();\n" }
      : source
  );
  assertEquals(
    inventoryErrors(
      registeredOwnership(changed),
      LEGACY_OWNERSHIP,
      new Set(sources.map((source) => source.file)),
    ),
    [`unowned capability: ${file}:${
      original.text.split("\n").length + 1
    }: Date.now: Date.now`],
  );
});

const imports = {
  "./totp.ts": "tests/helpers/totp.ts",
  "./clock.ts": "tests/helpers/fixture_clock.ts",
  "./totp_live.ts": LIVE_TOTP,
};
const forbidden = [
  "Date.now();",
  "const D = globalThis['Date']; D['n'+'ow']();",
  "const {now: live} = Date; live();",
  "new Date().getTime();",
  "performance.now();",
  "const method = input; Date[method]();",
  "class Hidden extends (Date.now(), Object) {}",
  "import {settledTotpNow as live} from './totp_live.ts'; await live();",
  "import * as live from './totp_live.ts'; live.unusedWindowCode(secret, []);",
  "import {} from './totp_live.ts';",
  "export {} from './totp_live.ts';",
  "export * from './totp_live.ts';",
  "await import('./totp_live.ts');",
  "export {unusedWindowCode} from './totp_live.ts';",
];
const forbiddenCapabilities = [
  "Date.now",
  "globalThis.*",
  "Date.*",
  "Date.*",
  "performance.now",
  "Date.*",
  "Date.now",
  ...Array(7).fill(`module:${LIVE_TOTP}`),
];
for (const extension of ["ts", "mjs"]) {
  for (const [index, text] of forbidden.entries()) {
    Deno.test(`fixture clock guard: ${extension} rejects positive live fallback ${index + 1}`, () => {
      const sites = fixtureClockSites([{
        file: `tests/positive_fixture.${extension}`,
        imports,
        text: `import {createFixtureClock} from './clock.ts';\n${text}`,
      }]);
      assertEquals(sites.map((site) => [site.file, site.capability]), [[
        `tests/positive_fixture.${extension}`,
        forbiddenCapabilities[index],
      ]]);
    });
  }
  Deno.test(`fixture clock guard: ${extension} permits explicit time and lexical shadows`, () => {
    assertEquals(
      fixtureClockSites([{
        file: `tests/positive_fixture.${extension}`,
        imports,
        text:
          `import {authenticatorCode} from './totp.ts'; authenticatorCode(secret, 1234567890000); function local(Date, performance) { Date.now(); performance.now(); } const text = 'Date.now()'; Date.UTC(2026, 0);`,
      }]),
      [],
    );
  });
}

Deno.test("isolation contract: P14 positive fixture clocks have only exact remaining legacy live-time sites", async () => {
  const sources = await repositorySources(
    fromFileUrl(new URL("../", import.meta.url)),
  );
  const files = new Set(sources.map((source) => source.file));
  for (
    const file of [
      "tests/helpers/fixture_clock.ts",
      "tests/helpers/driver_fixture.ts",
      "tests/fixture_clock_ownership_test.ts",
      "client/tests/e2e/native-totp-fixture.mjs",
    ]
  ) assert(files.has(file), `Lost P14 owner/consumer: ${file}`);
  assertEquals(
    inventoryErrors(registeredOwnership(sources), LEGACY_OWNERSHIP, files),
    [],
  );
});
