// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { analyzeOwnership, type OwnershipRules } from "./ownership_contract.ts";
/** Exercise every runtime acquisition form; aliases are not flow-tracked. */
export function assertPrivateModule(module: string, rules: OwnershipRules) {
  for (
    const text of [
      'import {binder as bind} from "private"; bind(input);',
      'import * as owner from "private"; owner[input()](value);',
      'import "private";',
      'const owner=await import("private"); owner.bind(value);',
      'export {binder as bind} from "private";',
      'export * from "private";',
      'export {} from "private";',
      'import owner = require("private"); owner.bind(input);',
    ]
  ) {
    const sites = analyzeOwnership([{
      file: "server/api/private-control.cts",
      text,
      imports: { private: module },
    }], rules);
    assertEquals(sites.length, 1, JSON.stringify(sites));
    assertEquals(sites[0].capability, `module:${module}`);
  }
  for (const file of rules.modules[module]) {
    assertEquals(
      analyzeOwnership([{
        file,
        text: 'import * as integration from "private";',
        imports: { private: module },
      }], rules),
      [],
    );
  }
  assertEquals(
    analyzeOwnership([{
      file: "server/api/private-control.ts",
      text: 'import type {Value} from "private";',
      imports: { private: module },
    }], rules),
    [],
  );
}
