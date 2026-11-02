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
    id: "single-child-launcher",
    scope: "tests",
    pattern: /new Deno\.Command\s*\(/,
    owners: ["tests/helpers/process.ts"],
    why:
      "children start through tests/helpers/process.ts (clearEnv plus an explicit environment), never inheriting the shared test-process environment",
  },
  {
    id: "no-port-probing",
    scope: "tests",
    pattern: /Deno\.listen\s*\(\s*\{[^}]*\bport:\s*0\b/,
    why:
      "a probed-and-released port can be taken before the child binds it; servers bind port 0 themselves and report the port (tests/helpers/boot.ts)",
  },
  {
    id: "single-port-owner",
    scope: "tests",
    pattern: /GLOBNOTES_PORT\b/,
    owners: ["tests/helpers/boot.ts"],
    why:
      "only the server launcher (tests/helpers/boot.ts) sets a server's port",
  },
  {
    id: "no-fixed-tmp-paths",
    scope: "tests",
    pattern: /["'`]\/tmp\//,
    why:
      "fixed shared paths can carry another run's data; tests create owned temp dirs (servers also refuse a cwd inside the checkout, tests/helpers/boot.ts)",
  },
  {
    id: "unique-remote-module-urls",
    scope: "tests",
    pattern: /import\(\s*['"`]https?:\/\/(?![^'"`]*\$\{modules\})/,
    why:
      "remote modules are cached by URL in the shared, persistent DENO_DIR; fixtures serve them under a per-fixture path (`${modules}`) so no run is answered from another run's cache",
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
