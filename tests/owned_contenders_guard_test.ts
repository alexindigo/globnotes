// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  familyInventoryErrors,
  inventoryErrors,
  repositorySources,
} from "./helpers/ownership_contract.ts";
import { operationCoordinationSites } from "./helpers/owned_operation_contract.ts";
import { registeredOwnership } from "./helpers/ownership_rules.ts";
import { LEGACY_OWNERSHIP } from "./helpers/ownership_legacy.ts";
// The contract, including both orderings, stays selected before P17 changes selection.
import "./owned_contenders_test.ts";

const adapter = "tests/helpers/owned_contenders.ts";
const pilot = "tests/owned_contenders_test.ts";
const guard = "tests/owned_contenders_guard_test.ts";
const protectedFiles = [adapter, pilot, guard];
const families = {
  "named-contender-contract": {
    replacement: "P16",
    closed: true,
    consumers: protectedFiles,
  },
};

for (const file of protectedFiles) {
  for (
    const member of ["remove", "truncate", "stdin", "futureFilesystemMember"]
  ) {
    Deno.test(`owned contenders guard: ${file} rejects unlisted Deno.${member}`, () => {
      assertEquals(
        inventoryErrors(
          registeredOwnership([{
            file,
            text: `Deno.${member};`,
          }]),
          [],
          new Set(),
        ),
        [
          `unowned capability: ${file}:1: Deno.${member}: Deno.${member}`,
        ],
      );
    });
  }
}
Deno.test("owned contenders guard: only the contracts can register tests", () => {
  assertEquals(
    inventoryErrors(
      registeredOwnership([
        { file: adapter, text: "Deno.test;" },
        { file: pilot, text: "Deno.test;" },
        { file: guard, text: "Deno.test;" },
      ]),
      [],
      new Set(),
    ),
    [
      `unowned capability: ${adapter}:1: Deno.test: Deno.test`,
    ],
  );
});

for (const extension of ["ts", "mjs"]) {
  for (
    const [index, [bypass, capability, source]] of [
      [
        "const {withResolvers: entry} = globalThis.Promise; entry();",
        "globalThis.Promise",
        "globalThis.Promise",
      ],
      [
        "const P = Promise; P['ra' + 'ce']([work, entered]);",
        "Promise.*",
        "Promise",
      ],
      [
        "const {setTimeout: later} = globalThis; later(callback, 1);",
        "globalThis.*",
        "globalThis",
      ],
      ["new Promise(resolve => remember(resolve));", "Promise.*", "Promise"],
    ].entries()
  ) {
    Deno.test(`owned contenders guard: ${extension} rejects raw coordinator ${index + 1} beside public import`, () => {
      const sites = operationCoordinationSites([{
        file: `tests/contender_scenario.${extension}`,
        text:
          `import {ownedContenders} from './helpers/owned_contenders.ts';\n${bypass}`,
        imports: { "./helpers/owned_contenders.ts": adapter },
      }]);
      assertEquals(inventoryErrors(sites, [], new Set()), [
        `unowned capability: tests/contender_scenario.${extension}:2: ${capability}: ${source}`,
      ]);
    });
  }
}

Deno.test("owned contenders guard: adapter and contracts gain no raw coordination exemption", async () => {
  const sources = await repositorySources(
    fromFileUrl(new URL("../", import.meta.url)),
  );
  for (const file of protectedFiles) {
    const source = sources.find((source) => source.file === file)!;
    const text = source.text;
    assertEquals(operationCoordinationSites([source]), []);
    for (
      const [bypass, capability, reference] of [
        [
          "Promise.withResolvers();",
          "Promise.withResolvers",
          "Promise.withResolvers",
        ],
        ["Promise.race([a,b]);", "Promise.race", "Promise.race"],
        ["setTimeout(callback, 1);", "setTimeout.*", "setTimeout"],
      ]
    ) {
      assertEquals(
        inventoryErrors(
          operationCoordinationSites([{
            ...source,
            text: text + "\n" + bypass,
          }]),
          [],
          new Set(),
        ),
        [
          `unowned capability: ${file}:${
            text.split("\n").length + 1
          }: ${capability}: ${reference}`,
        ],
      );
    }
  }
});

Deno.test("isolation contract: P16 contender pilot has no bypasses and retains its owner/consumer", async () => {
  const sources = await repositorySources(
    fromFileUrl(new URL("../", import.meta.url)),
  );
  const files = new Set(sources.map((source) => source.file));
  assertEquals(familyInventoryErrors([], families, files, new Set()), []);
  assertEquals(
    inventoryErrors(registeredOwnership(sources), LEGACY_OWNERSHIP, files),
    [],
  );
  for (const file of protectedFiles) {
    const omitted = new Set(files);
    omitted.delete(file);
    assertEquals(familyInventoryErrors([], families, omitted, new Set()), [
      `lost named-contender-contract consumer: ${file}`,
    ]);
  }
});
