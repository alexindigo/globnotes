// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { inventoryErrors } from "./helpers/ownership_contract.ts";
import {
  DRIVER_FIXTURE,
  DRIVER_PRELOAD,
  DRIVER_PROTOCOL,
  DRIVER_STARTUP,
  registeredOwnership,
} from "./helpers/ownership_rules.ts";
import { operationCoordinationSites } from "./helpers/owned_operation_contract.ts";
const imports = {
  "./driver_startup.ts": DRIVER_STARTUP,
  "./driver_startup_preload.ts": DRIVER_PRELOAD,
  "./driver_startup_protocol.ts": DRIVER_PROTOCOL,
};
for (
  const [file, text, capability, source] of [
    [
      "tests/scenario.ts",
      'import {bindDriverStartup as bind} from "./driver_startup.ts"; bind(root, server, current);',
      `module:${DRIVER_STARTUP}`,
      '"./driver_startup.ts"',
    ],
    [
      DRIVER_FIXTURE,
      'import * as protocol from "./driver_startup_protocol.ts"; protocol["publishDriverStartup"](root, value);',
      `module:${DRIVER_PROTOCOL}`,
      '"./driver_startup_protocol.ts"',
    ],
    [
      "tests/scenario.ts",
      'export {} from "./driver_startup_protocol.ts";',
      `module:${DRIVER_PROTOCOL}`,
      '"./driver_startup_protocol.ts"',
    ],
    [
      "server/example.ts",
      'import {bindDriverStartup} from "./driver_startup.ts"; bindDriverStartup(root, server, current);',
      `module:${DRIVER_STARTUP}`,
      '"./driver_startup.ts"',
    ],
    [
      "tests/scenario.ts",
      'import {observeDriverStartup} from "./driver_startup_preload.ts"; observeDriverStartup(root);',
      `module:${DRIVER_PRELOAD}`,
      '"./driver_startup_preload.ts"',
    ],
    [
      DRIVER_PRELOAD,
      'const {writeTextFileSync: write} = Deno; write(file, "{}");',
      "Deno.*",
      "Deno",
    ],
    [DRIVER_STARTUP, 'Deno["watchFs"](root);', "Deno.*", 'Deno["watchFs"]'],
  ] as const
) {
  Deno.test(`driver phase guard: rejects bypass ${text}`, () => {
    const sites = registeredOwnership([{ file, text, imports }]);
    assertEquals(
      inventoryErrors(sites, [], new Set()),
      [`unowned capability: ${file}:1: ${capability}: ${source}`],
    );
  });
}
for (
  const file of [
    DRIVER_STARTUP,
    DRIVER_PRELOAD,
    DRIVER_PROTOCOL,
    DRIVER_FIXTURE,
  ]
) {
  Deno.test(`driver phase review: ${file} rejects undeclared Deno capabilities`, () => {
    for (
      const member of [
        "remove",
        "removeSync",
        "truncate",
        "futureFilesystemAPI",
      ]
    ) {
      const source = `Deno.${member}`;
      assertEquals(
        inventoryErrors(
          registeredOwnership([{ file, text: `${source}(value);` }]),
          [],
          new Set(),
        ),
        [`unowned capability: ${file}:1: ${source}: ${source}`],
      );
    }
  });
}
for (
  const file of [
    DRIVER_STARTUP,
    DRIVER_PRELOAD,
    DRIVER_FIXTURE,
    "tests/hub_driver_acceptance_test.ts",
  ]
) {
  Deno.test(`driver phase guard: ${file} cannot create a private deadline or deferred`, () => {
    for (
      const [text, capability] of [
        ["Promise.withResolvers();", "Promise.withResolvers"],
        ["globalThis.setTimeout(callback, 1);", "globalThis.setTimeout"],
        ["Promise.race([work, other]);", "Promise.race"],
      ]
    ) {
      assertEquals(
        inventoryErrors(
          operationCoordinationSites([{ file, text }]),
          [],
          new Set(),
        ),
        [`unowned capability: ${file}:1: ${capability}: ${capability}`],
      );
    }
  });
}
