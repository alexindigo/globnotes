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
  /** Directories (relative to the repo root) whose source files are scanned. */
  scopes: string[];
  pattern: RegExp;
  /** Files (relative to the repo root) that own the resource. */
  owners?: string[];
  /** Paths (files or directories, relative to the repo root) the rule does
   * not cover, each with its reason. */
  exempt?: { path: string; reason: string }[];
  /** Individual source lines (trimmed, exact) the rule tolerates, each with
   * its reason. An entry that no longer matches a line fails the rule. */
  allowed?: { file: string; line: string; reason: string }[];
  why: string;
}

/** Lines where a wall-clock bound is part of what the test asserts, or an
 * ambiguous loop kept as is (plans/commit-check notes/readiness-handoff.md). */
const READINESS_ALLOWED: NonNullable<Rule["allowed"]> = [
  {
    file: "client/tests/e2e/autosave-timer.mjs",
    line: "} while (Date.now() - start < timeout);",
    reason:
      "asserted timing: disk() fails when the autosave does not reach disk within its budget (5 s, 7 s for interval mode); the budget is the autosave behaviour under test",
  },
  {
    file: "client/tests/e2e/autosave-timer.mjs",
    line:
      'assert(mutations("readme").length === pauseCount + 1 && Date.now() - pauseStart < 5000, "Pause autosave did not complete once within 5s");',
    reason: "asserted timing: pause autosave completes exactly once within 5 s",
  },
  {
    file: "client/tests/e2e/autosave-timer.mjs",
    line: "while (Date.now() - continuousStart < 6000) {",
    reason:
      "asserted timing: the 6 s continuous-typing window in which pause mode must not write",
  },
  {
    file: "client/tests/e2e/autosave-timer.mjs",
    line: "while (Date.now() - intervalStart < 11500) {",
    reason:
      "asserted timing: the 11.5 s window in which interval mode must write its ticks",
  },
  {
    file: "client/tests/e2e/plugin-prefix-auth.mjs",
    line:
      'for (const end = Date.now() + 3500; !expired.state.closed;) { assert(Date.now() < end, "Prefix/auth consumer observation deadline"); await new Promise(resolve => setTimeout(resolve, 25)); }',
    reason:
      "ambiguous, kept as is: the 3.5 s bound may be part of the expiry claim (a 2 s signed expiry closes the stream promptly, before any heartbeat)",
  },
  {
    file: "client/tests/e2e/settings-pending-native.mjs",
    line: "const deadline = Date.now() + 15000;",
    reason:
      "ambiguous, kept as is: pollGate's bound must outlast the product's pending-response window it also waits through (`Date.now() - gate.response.at > 11000`)",
  },
  {
    file: "tests/hub_scanner_test.ts",
    line: "const deadline = Date.now() + 1500;",
    reason:
      "ambiguous, kept as is: the 1.5 s bound tells the 0.05 s fallback interval read at construction from the later 60 s value",
  },
  {
    file: "tests/hub_scanner_test.ts",
    line: "const deadline = Date.now() + 2500;",
    reason:
      "ambiguous, kept as is: the 2.5 s bound tells watcher delivery from the 60 s default periodic scan",
  },
  {
    file: "tests/plugin_lifecycle_test.ts",
    line: "const hangDeadline = Date.now() + serviceCallMs + 5000;",
    reason:
      "ambiguous, kept as is: the bound is the product's call deadline (serviceCallMs) plus margin and its expiry is not a failure (the test then accepts failed or deliveryFailures >= 1)",
  },
];

/** Server lines that read a raw clock or arm a raw timer outside the
 * observed-time owner (plans/scheduling-tolerance): wall-clock properties and
 * pacing, none of which turns a scheduling stall into a failure. */
const RAW_CLOCK_ALLOWED: NonNullable<Rule["allowed"]> = [
  {
    file: "server/auth/local.ts",
    line: "const exp = Math.floor(Date.now() / 1000) +",
    reason: "wall clock by design: a token's expiry is a real-time property",
  },
  {
    file: "server/auth/middleware.ts",
    line: "(metadata.expiresAt !== null && Date.now() >= metadata.expiresAt)",
    reason:
      "wall clock by design: an expired credential stays expired across a stall",
  },
  {
    file: "server/api/endpoints/_/api/plugin-host/events/get.ts",
    line:
      "if (current.expiresAt !== null && Date.now() >= current.expiresAt) {",
    reason: "wall clock by design: credential expiry closes the stream",
  },
  {
    file: "server/api/endpoints/_/api/plugin-host/events/get.ts",
    line: ": { at: Date.now() },",
    reason: "a timestamp in the hello frame, not a budget",
  },
  {
    file: "server/api/endpoints/_/api/plugin-host/events/get.ts",
    line: "const heartbeat = setInterval(",
    reason: "keepalive cadence the server emits; nothing fails when it is late",
  },
  {
    file: "server/api/endpoints/_/api/plugin-host/events/get.ts",
    line: "const remaining = admitted.expiresAt - Date.now();",
    reason: "wall clock by design: the stream closes at credential expiry",
  },
  {
    file: "server/api/endpoints/_/api/plugin-host/events/get.ts",
    line: "expiryTimer = setTimeout(",
    reason: "wall clock by design: the stream closes at credential expiry",
  },
  {
    file: "server/api/endpoints/_/api/changes/get.ts",
    line: "const heartbeat = setInterval(() => emit(), 25_000);",
    reason: "keepalive cadence the server emits; nothing fails when it is late",
  },
  {
    file: "server/api/endpoints/_/api/changes/get.ts",
    line: "const remaining = admitted.expiresAt - Date.now();",
    reason: "wall clock by design: the stream closes at credential expiry",
  },
  {
    file: "server/api/endpoints/_/api/changes/get.ts",
    line: "else expiry = setTimeout(expire, Math.min(remaining, 2147483647));",
    reason: "wall clock by design: the stream closes at credential expiry",
  },
  {
    file: "server/plugins/lifecycle.ts",
    line: "this.managedWrites.set(filename, { deletedAt: Date.now() });",
    reason: "compared with filesystem mtimes, which are wall-clock times",
  },
  {
    file: "server/notes/file_system.ts",
    line: "const now = performance.now() / 1000;",
    reason:
      "scan-cache freshness against outside edits; a stall only expires the cache",
  },
  {
    file: "server/search/fts5.ts",
    line:
      "const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));",
    reason: "index batch pacing; never a bound",
  },
  {
    file: "server/plugins/host.ts",
    line: "await new Promise((resolve) => setTimeout(resolve, 5));",
    reason: "disposal poll pacing; the disposal budget itself is observed time",
  },
  {
    file: "server/hub/hub.ts",
    line: "this.#timer = setInterval(() => this.#rescan(), this.#intervalMs);",
    reason: "periodic scan cadence; a late scan is still a scan",
  },
  {
    file: "server/hub/hub.ts",
    line: "this.#debounce = setTimeout(() => {",
    reason: "watcher debounce; pacing only",
  },
];

const RULES: Rule[] = [
  {
    id: "no-process-env-writes",
    scopes: ["tests"],
    pattern: /Deno\.env\.(set|delete)\s*\(/,
    why:
      "tests configure in-process objects with tests/helpers/environment.ts and children through the launcher, never the shared process environment",
  },
  {
    id: "single-child-launcher",
    scopes: ["tests"],
    pattern: /new Deno\.Command\s*\(/,
    owners: ["tests/helpers/process.ts"],
    why:
      "children start through tests/helpers/process.ts (clearEnv plus an explicit environment), never inheriting the shared test-process environment",
  },
  {
    id: "scoped-plugin-manager",
    scopes: ["tests"],
    pattern: /new\s+PluginManager\s*\(/,
    owners: ["tests/helpers/plugin_manager.ts"],
    why:
      "test managers are created by tests/helpers/plugin_manager.ts, which supplies a scoped Environment instead of processEnvironment",
  },
  {
    id: "no-port-probing",
    scopes: ["tests"],
    pattern: /Deno\.listen\s*\(\s*\{[^}]*\bport:\s*0\b/,
    why:
      "a probed-and-released port can be taken before the child binds it; servers bind port 0 themselves and report the port (tests/helpers/boot.ts)",
  },
  {
    id: "single-port-owner",
    scopes: ["tests"],
    pattern: /GLOBNOTES_PORT\b/,
    owners: ["tests/helpers/boot.ts"],
    why:
      "only the server launcher (tests/helpers/boot.ts) sets a server's port",
  },
  {
    id: "no-fixed-tmp-paths",
    scopes: ["tests"],
    pattern: /["'`]\/tmp\//,
    why:
      "fixed shared paths can carry another run's data; tests create owned temp dirs (servers also refuse a cwd inside the checkout, tests/helpers/boot.ts)",
  },
  {
    id: "unique-remote-module-urls",
    scopes: ["tests"],
    // Dynamic `import("http...")` and static `import ... from "http..."` /
    // `import "http..."` alike: both are resolved through the module cache.
    pattern:
      /(?:\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)['"`]https?:\/\/(?![^'"`]*\$\{modules\})/,
    why:
      "remote modules, imported dynamically or statically, are cached by URL in the shared, persistent DENO_DIR; fixtures serve them under a per-fixture path (`${modules}`) so no run is answered from another run's cache",
  },
  {
    id: "single-process-env-owner",
    scopes: ["server"],
    pattern: /Deno\.env\b/,
    owners: ["server/environment.ts", "server/logger.ts"],
    why:
      "server components receive an Environment (server/environment.ts); logger.ts reads LOGLEVEL once at import",
  },
  {
    id: "observed-time-owner",
    scopes: ["server"],
    pattern: /\b(?:Date|performance)\.now\(\)|\bset(?:Timeout|Interval)\s*\(/,
    owners: ["server/observed_time.ts"],
    exempt: [{
      path: "server/plugins/worker_entry.ts",
      reason:
        "worker side: the heartbeat producer and plugin-managed timers; the host decides liveness",
    }],
    allowed: RAW_CLOCK_ALLOWED,
    why:
      "liveness and deadline checks measure observed time through server/observed_time.ts (processClock / ObservedClock), so a stall of this process is not blamed on a plugin or an operation. A raw clock read or timer is a wall-clock property or pacing, listed in RAW_CLOCK_ALLOWED with its reason",
  },
  {
    id: "single-readiness-bound",
    scopes: ["tests", "client/tests/e2e"],
    // Deadline arithmetic (`deadline = Date.now() + n`, also inside
    // Math.min/max) and elapsed-time loop bounds (`Date.now() - start < n`).
    pattern:
      /[=:]\s*(?:Math\.(?:min|max)\([^;]*)?\b(?:Date|performance)\.now\(\)\s*\+|\b(?:Date|performance)\.now\(\)\s*-\s*\w+\s*<=?/,
    owners: ["tests/helpers/wait.ts"],
    exempt: [{
      path: "tests/timing",
      reason:
        "timing-budget tests: the bound is the asserted property (phase-1 decision row 6); they run serially",
    }],
    allowed: READINESS_ALLOWED,
    why:
      "readiness waits go through waitUntil (tests/helpers/wait.ts): one bound, terminal states fail at once, the last observed state is reported. A bound that is the asserted property lives in tests/timing/ or is listed in READINESS_ALLOWED with its reason",
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

const within = (relative: string, prefix: string) =>
  relative === prefix || relative.startsWith(prefix + path.SEPARATOR);

/** Where `pattern` matches in a file's text, one entry per line a match
 * starts on. The pattern runs over the whole text, not line by line: a
 * construct the formatter (or a fixture's template string) splits across
 * lines, such as `import(\n  "http://..."\n)` or a multi-line
 * `Deno.listen({ ... })`, is still found. Each match is reported at, and
 * allowlisted by, the trimmed text of the line it starts on. */
function matches(
  pattern: RegExp,
  text: string,
): { line: number; text: string }[] {
  const lines = text.split("\n");
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
  );
  const found = new Map<number, string>();
  for (const match of text.matchAll(global)) {
    const line = text.slice(0, match.index).split("\n").length;
    found.set(line, lines[line - 1].trim());
  }
  return [...found].map(([line, text]) => ({ line, text }));
}

/** The rule's violations, plus allowlist entries that matched nothing. */
async function scan(rule: Rule): Promise<string[]> {
  const violations: string[] = [];
  const used = new Set<number>();
  for (const scope of rule.scopes) {
    for await (const file of sources(path.join(ROOT, scope))) {
      const relative = path.relative(ROOT, file);
      if (file === SELF || rule.owners?.includes(relative)) continue;
      if (rule.exempt?.some((entry) => within(relative, entry.path))) continue;
      const text = await Deno.readTextFile(file);
      for (const { line, text: start } of matches(rule.pattern, text)) {
        const allowed = rule.allowed?.findIndex((entry) =>
          entry.file === relative && entry.line === start
        ) ?? -1;
        if (allowed >= 0) {
          used.add(allowed);
        } else violations.push(`${relative}:${line}: ${start}`);
      }
    }
  }
  rule.allowed?.forEach((entry, index) => {
    if (!used.has(index)) {
      violations.push(`stale allowlist entry ${entry.file}: ${entry.line}`);
    }
  });
  return violations;
}

const rule = (id: string) => RULES.find((entry) => entry.id === id)!.pattern;

Deno.test("isolation contract: rules see constructs split across lines", () => {
  const remote = rule("unique-remote-module-urls");
  const lines = (text: string) => matches(remote, text).map((m) => m.line);
  // A long dynamic import the formatter breaks after `import(`.
  assertEquals(lines('x;\nawait import(\n  "http://h:1/module.js",\n);'), [2]);
  // A static import whose `from` and URL are on separate lines.
  assertEquals(lines('import {\n  value,\n} from\n  "http://h:1/m.js";'), [3]);
  assertEquals(lines("import\n  'https://h:1/side-effect.js';"), [1]);
  // A per-fixture module path is still accepted when split.
  assertEquals(
    lines("await import(\n  `http://${authority}${modules}/module.js`,\n);"),
    [],
  );
  assertEquals(
    matches(
      rule("no-port-probing"),
      'Deno.listen({\n  hostname: "127.0.0.1",\n  port: 0,\n});',
    ),
    [{ line: 1, text: "Deno.listen({" }],
  );
});

for (const rule of RULES) {
  Deno.test(`isolation contract: ${rule.id}`, async () => {
    assertEquals(await scan(rule), [], `${rule.id}: ${rule.why}`);
  });
}
