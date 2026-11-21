// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  familyInventoryErrors,
  inventoryErrors,
  type LegacySite,
  type OwnershipFamily,
  repositorySources,
  type SourceModule,
} from "./helpers/ownership_contract.ts";
import { operationCoordinationSites } from "./helpers/owned_operation_contract.ts";
import legacy from "./helpers/owned_operation_legacy.json" with {
  type: "json",
};
import families from "./helpers/owned_operation_families.json" with {
  type: "json",
};
import { SELECTION } from "../client/tests/e2e/legacy-native-suite.mjs";
import { registeredOwnership } from "./helpers/ownership_rules.ts";
import { LEGACY_OWNERSHIP } from "./helpers/ownership_legacy.ts";

Deno.test("bound operation guard: boot cannot own a raw constructor or cancellation race", () => {
  const file = "tests/helpers/boot.ts";
  const sites = registeredOwnership([{
    file,
    text: "new Promise(() => {});\nPromise.race([]);",
  }]);
  assertEquals(
    sites.map(({ capability, source }) => ({ capability, source })),
    [
      { capability: "Promise.*", source: "Promise" },
      { capability: "Promise.race", source: "Promise.race" },
    ],
  );
});

for (
  const file of [
    "tests/helpers/owned_operation.ts",
    "tests/plugin_settings_schema_lease_test.ts",
  ]
) {
  for (
    const member of ["remove", "truncate", "stdin", "futureFilesystemOperation"]
  ) {
    Deno.test(`owned operation review: ${file} rejects unlisted Deno.${member}`, () => {
      const sites = registeredOwnership([{ file, text: `Deno.${member};` }]);
      assertEquals(
        sites.map(({ file, capability, source }) => ({
          file,
          capability,
          source,
        })),
        [
          { file, capability: `Deno.${member}`, source: `Deno.${member}` },
        ],
      );
    });
  }
}

Deno.test("owned operation review: only the schema pilot owns its enumerated filesystem ports", () => {
  const members = ["test", "readTextFile", "writeTextFile"];
  const text = members.map((member) => `Deno.${member};`).join("\n");
  assertEquals(
    registeredOwnership([{
      file: "tests/plugin_settings_schema_lease_test.ts",
      text,
    }]),
    [],
  );
  assertEquals(
    registeredOwnership([{ file: "tests/helpers/owned_operation.ts", text }])
      .map(({ capability, source }) => ({ capability, source })),
    members.map((member) => ({
      capability: `Deno.${member}`,
      source: `Deno.${member}`,
    })),
  );
});

Deno.test("owned operation guard: inherited constructors have exact owners without relaxing scenario gates", () => {
  const sites = registeredOwnership([
    {
      file: "tests/helpers/fixture_coordination.ts",
      text:
        "new Promise(() => {}); Promise.withResolvers(); Promise.race([]); Promise['race']([]);",
    },
    {
      file: "tests/fixture_scope_test.ts",
      text: "new Promise(() => {}); Promise.withResolvers();",
    },
    {
      file: "tests/owned_operation_test.ts",
      text: "new Promise(() => {}); Promise.withResolvers();",
    },
  ]);
  assertEquals(
    sites.map(({ file, capability, source }) => ({ file, capability, source })),
    [
      {
        file: "tests/helpers/fixture_coordination.ts",
        capability: "Promise.race",
        source: "Promise.race",
      },
      {
        file: "tests/helpers/fixture_coordination.ts",
        capability: "Promise.*",
        source: "Promise['race']",
      },
      {
        file: "tests/owned_operation_test.ts",
        capability: "Promise.*",
        source: "Promise",
      },
      {
        file: "tests/fixture_scope_test.ts",
        capability: "Promise.*",
        source: "Promise",
      },
      {
        file: "tests/fixture_scope_test.ts",
        capability: "Promise.withResolvers",
        source: "Promise.withResolvers",
      },
    ],
  );
});

export const OPERATION_LEGACY: LegacySite[] = legacy.map((site) => ({
  ...site,
  ...families[site.family as keyof typeof families],
}));
export const OPERATION_FAMILIES: Record<string, OwnershipFamily> = {
  "schema-lease-held-work": {
    replacement: "P04",
    closed: true,
    consumers: [
      "tests/owned_operation_test.ts",
      "tests/plugin_settings_schema_lease_test.ts",
    ],
  },
  ...families,
};

function errors(sources: SourceModule[]) {
  return inventoryErrors(operationCoordinationSites(sources), [], new Set());
}

const bypasses = [
  "const entered = Promise.withResolvers(); await entered.promise;",
  "new Promise(resolve => save(resolve));",
  "if (result instanceof Promise) await result;",
  "Promise.race([work, entered]);",
  "Promise.any([work, entered]);",
  "const P = Promise; const method = 'ra' + 'ce'; P[method]([work, entered]);",
  "const {withResolvers: deferred} = Promise; deferred();",
  "const P = globalThis['Promise']; P.race([work, entered]);",
  "const arm = setTimeout; arm(callback, 5);",
  "globalThis['setTimeout'](callback, 5);",
  "const {setInterval: arm} = globalThis; arm(callback, 5);",
  "import {setTimeout as delay} from 'node:timers/promises'; await delay(5);",
  "import * as timers from 'node:timers'; timers['setImmediate'](callback);",
  "const {setTimeout: delay} = await import('node:timers/promises'); await delay(5);",
  "const P = Promise; P[unknown]();",
  "const box = {P: Promise}; consume(box);",
  "const [P] = [Promise]; new P(resolve => resolve());",
  "const P = Promise.bind(null); new P(resolve => resolve());",
  "const P = Promise.prototype.constructor; new P(resolve => resolve());",
  "function factory() { return Promise; } const P = factory(); P.race([a,b]);",
  "let P; P = globalThis.Promise; new P(resolve => resolve());",
  "const {Promise: {race: first}} = globalThis; first([a,b]);",
  "import {heldOperation} from './helpers/owned_operation.ts'; Promise.race([work, entered]);",
];
const expectedBypasses = [
  ["Promise.withResolvers", "Promise.withResolvers"],
  ["Promise.*", "Promise"],
  ["Promise.*", "Promise"],
  ["Promise.race", "Promise.race"],
  ["Promise.any", "Promise.any"],
  ["Promise.*", "Promise"],
  ["Promise.*", "Promise"],
  ["globalThis.*", "globalThis['Promise']"],
  ["setTimeout.*", "setTimeout"],
  ["globalThis.*", "globalThis['setTimeout']"],
  ["globalThis.*", "globalThis"],
  ["module:node:timers/promises", "'node:timers/promises'"],
  ["module:node:timers", "'node:timers'"],
  ["module:node:timers/promises", "'node:timers/promises'"],
  ["Promise.*", "Promise"],
  ["Promise.*", "Promise"],
  ["Promise.*", "Promise"],
  ["Promise.bind", "Promise.bind"],
  ["Promise.prototype", "Promise.prototype"],
  ["Promise.*", "Promise"],
  ["globalThis.Promise", "globalThis.Promise"],
  ["globalThis.*", "globalThis"],
  ["Promise.race", "Promise.race"],
];
for (const extension of ["ts", "mjs"]) {
  for (const [index, text] of bypasses.entries()) {
    Deno.test(`owned operation guard: ${extension} rejects coordinator ${index + 1}`, () => {
      const file = `tests/scenario.${extension}`;
      const [capability, source] = expectedBypasses[index];
      assertEquals(
        errors([{
          file,
          text,
          imports: {
            "./helpers/owned_operation.ts": "tests/helpers/owned_operation.ts",
          },
        }]),
        [`unowned capability: ${file}:1: ${capability}: ${source}`],
      );
    });
  }
  Deno.test(`owned operation guard: ${extension} permits results, domain calls, strings and shadowing`, () => {
    assertEquals(
      errors([{
        file: `tests/scenario.${extension}`,
        text: `
      import {heldOperation} from './helpers/owned_operation.ts';
      const result = Promise.resolve(value); await Promise.all([result]);
      const text = 'new Promise setTimeout Promise.race'; // Promise.withResolvers()
      const local = (Promise, setTimeout) => Promise.race([setTimeout()]);
    `,
        imports: {
          "./helpers/owned_operation.ts": "tests/helpers/owned_operation.ts",
        },
      }]),
      [],
    );
  });
}

Deno.test("owned operation guard: alias exports cannot hide raw provenance", () => {
  const sources: SourceModule[] = [
    {
      file: "shared/raw.js",
      text: "export const deferred = Promise.withResolvers;",
    },
    {
      file: "shared/bridge.js",
      text: 'export {deferred as gate} from "./raw.js";',
      imports: { "./raw.js": "shared/raw.js" },
    },
    {
      file: "client/tests/e2e/consumer.mjs",
      text: 'import {gate} from "../../../shared/bridge.js"; gate();',
      imports: { "../../../shared/bridge.js": "shared/bridge.js" },
    },
  ];
  const sites = registeredOwnership(sources);
  assertEquals(sites.map((site) => [site.file, site.capability]), [[
    "shared/raw.js",
    "Promise.withResolvers",
  ]]);
});

Deno.test("owned operation guard: local scheduler method names are not global timer acquisition", () => {
  assertEquals(
    errors([{
      file: "tests/local_scheduler.ts",
      text: `const scheduler = {
      setTimeout(callback) { return 1; },
      setInterval(callback) { return 2; },
    }; scheduler.setTimeout(callback); scheduler.setInterval(callback);
    class Clock { setTimeout = () => 1; setInterval = () => 2; }
    const clock = new Clock(); clock.setTimeout(); clock.setInterval();`,
    }]),
    [],
  );
  assertEquals(
    errors([{
      file: "tests/raw_scheduler.ts",
      text: "const scheduler = {setTimeout, setInterval};",
    }]),
    [
      "unowned capability: tests/raw_scheduler.ts:1: setInterval.*: setInterval",
      "unowned capability: tests/raw_scheduler.ts:1: setTimeout.*: setTimeout",
    ],
  );
});

Deno.test("owned operation guard: real adapter may issue gates, never another race or timer", async () => {
  const file = "tests/helpers/owned_operation.ts";
  const text = await Deno.readTextFile(new URL("../" + file, import.meta.url));
  const imports = {
    "./fixture_scope.ts": "tests/helpers/fixture_scope.ts",
    "./fixture_coordination.ts": "tests/helpers/fixture_coordination.ts",
    "./product_settlement.ts": "tests/helpers/product_settlement.ts",
    "./wait.ts": "tests/helpers/wait.ts",
  };
  assertEquals(errors([{ file, text, imports }]), []);
  for (
    const [added, capability, source] of [
      ["Promise.race([a, b]);", "Promise.race", "Promise.race"],
      ["setTimeout(callback, 5);", "setTimeout.*", "setTimeout"],
      ["new Promise(resolve => resolve());", "Promise.*", "Promise"],
    ]
  ) {
    assertEquals(
      errors([{ file, text: text + "\n" + added, imports }]),
      [`unowned capability: ${file}:${
        text.split("\n").length + 1
      }: ${capability}: ${source}`],
    );
  }
});

Deno.test("owned operation guard: exact inventory cannot bless another occurrence or false closure", () => {
  const sources = [{ file: "tests/scenario.ts", text: "Promise.race([a,b]);" }];
  const sites = operationCoordinationSites(sources);
  const inventory = sites.map((site) => ({
    ...site,
    family: "scenario",
    replacement: "A11",
    consumers: ["tests/scenario.ts"],
  }));
  const files = new Set(sources.map((source) => source.file));
  assertEquals(inventoryErrors(sites, inventory, files), []);
  assertEquals(inventoryErrors([...sites, ...sites], inventory, files), [
    "unowned capability: tests/scenario.ts:1: Promise.race: Promise.race",
  ]);
  assertEquals(
    inventoryErrors([], inventory, files),
    ["stale inventory: tests/scenario.ts:1: Promise.race"],
  );
  assertEquals(
    familyInventoryErrors(
      inventory,
      { scenario: { replacement: "A11", closed: true, consumers: [...files] } },
      files,
      new Set(),
    ),
    ["residual inventory declared closed: scenario"],
  );
});

Deno.test("isolation contract: P04 parsed coordination pilot and finite legacy inventory", async () => {
  const sources = await repositorySources(
    new URL("../", import.meta.url).pathname,
  );
  const files = new Set(sources.map((source) => source.file));
  const sites = registeredOwnership(sources);
  assertEquals(inventoryErrors(sites, LEGACY_OWNERSHIP, files), []);
  assertEquals(
    familyInventoryErrors(
      OPERATION_LEGACY,
      OPERATION_FAMILIES,
      files,
      new Set(SELECTION.map(([name]) => `client/tests/e2e/${name}.mjs`)),
    ),
    [],
  );
  assertEquals(
    sites.filter((site) =>
      site.file === "tests/plugin_settings_schema_lease_test.ts"
    ),
    [],
  );
});
