// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Test-isolation contract (plans/test-isolation). `deno test --parallel`
 * runs test modules as concurrent workers of one OS process: the process
 * environment, cwd and loopback ports are shared by every module running at
 * the same time and inherited by every child they spawn. These rules keep
 * each test's external resources owned by the shared helpers, so a test
 * cannot reach another test's configuration, state or server — the scan makes
 * a bypass fail the gate instead of flaking later.
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";

const ROOT = path.fromFileUrl(new URL("../", import.meta.url));
const SELF = path.fromFileUrl(import.meta.url);

interface Rule {
  id: string;
  /** Directory (relative to the repo root) whose source files are scanned. */
  scope: string;
  pattern: RegExp;
  /** Files (relative to the repo root) that own the resource. */
  owners?: string[];
  why: string;
}

const RULES: Rule[] = [
  {
    id: "no-process-env-writes",
    scope: "tests",
    pattern: /Deno\.env\.(set|delete)\s*\(/,
    why:
      "tests configure in-process objects with tests/helpers/environment.ts and children through the launcher, never the shared process environment",
  },
  {
    id: "single-process-env-owner",
    scope: "server",
    pattern: /Deno\.env\b/,
    owners: ["server/environment.ts", "server/logger.ts"],
    why:
      "server components receive an Environment (server/environment.ts); logger.ts reads LOGLEVEL once at import",
  },
];

const SOURCE = /\.(ts|js|mjs)$/;

async function* sources(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === "client") continue;
      yield* sources(full);
    } else if (entry.isFile && SOURCE.test(entry.name)) yield full;
  }
}

for (const rule of RULES) {
  Deno.test(`isolation contract: ${rule.id}`, async () => {
    const violations: string[] = [];
    for await (const file of sources(path.join(ROOT, rule.scope))) {
      const relative = path.relative(ROOT, file);
      if (file === SELF || rule.owners?.includes(relative)) continue;
      const lines = (await Deno.readTextFile(file)).split("\n");
      lines.forEach((line, index) => {
        if (rule.pattern.test(line)) {
          violations.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assertEquals(violations, [], `${rule.id}: ${rule.why}`);
  });
}
