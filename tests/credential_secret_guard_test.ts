// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  analyzeOwnership,
  type SourceModule,
} from "./helpers/ownership_contract.ts";
import { SECRET_CODEC, SECRET_OWNERSHIP } from "./helpers/ownership_rules.ts";

const source = (
  text: string,
  file = "server/api/credential-control.ts",
): SourceModule => ({
  file,
  text,
  imports: { codec: SECRET_CODEC },
});
Deno.test("secret registration: runtime codec imports reject at the producer, not aliases", () => {
  for (
    const text of [
      'import {decodeStoredTotpSecret as decode} from "codec"; decode(key);',
      'import * as codec from "codec"; codec[input()](key);',
      'import "codec";',
      'const {decodeStoredTotpSecret: decode}=await import("codec"); decode(key);',
      'export {decodeStoredTotpSecret as decode} from "codec";',
      'export * from "codec";',
      'export {} from "codec";',
      'import codec = require("codec"); codec.decodeStoredTotpSecret(key);',
    ]
  ) {
    const sites = analyzeOwnership([source(text)], SECRET_OWNERSHIP);
    assertEquals(sites.length, 1, JSON.stringify(sites));
    assertEquals(sites[0].capability, `module:${SECRET_CODEC}`);
  }
});
Deno.test("secret registration: exact codec owners and erased types remain available", () => {
  for (const file of SECRET_OWNERSHIP.modules[SECRET_CODEC]) {
    assertEquals(
      analyzeOwnership([
        source('import {decodeStoredTotpSecret} from "codec";', file),
      ], SECRET_OWNERSHIP),
      [],
    );
  }
  assertEquals(
    analyzeOwnership([
      source(
        'import type {StoredTotpSecret} from "codec"; new TextEncoder().encode(text);',
      ),
    ], SECRET_OWNERSHIP),
    [],
  );
});
Deno.test("secret registration: public encoder references do not require credential flow tracking", () => {
  assertEquals(
    analyzeOwnership([
      source(
        "const Encoder=TextEncoder; const encode=(value)=>new Encoder().encode(value); encode(text);",
      ),
    ], SECRET_OWNERSHIP),
    [],
  );
});
Deno.test("secret registration: a codec re-export rejects once at its producer", () => {
  const sites = analyzeOwnership([
    source(
      'export {decodeStoredTotpSecret as decode} from "codec";',
      "server/bridge.ts",
    ),
    {
      file: "server/api/controller.ts",
      text: 'import {decode} from "bridge"; decode(text);',
      imports: { bridge: "server/bridge.ts" },
    },
  ], SECRET_OWNERSHIP);
  assertEquals(sites.length, 1);
  assertEquals(sites[0].file, "server/bridge.ts");
  assert(sites[0].capability === `module:${SECRET_CODEC}`);
});
