// SPDX-License-Identifier: LGPL-3.0-only

/** Fast pre-commit feedback on the staged tree. CI owns the full gate.
 * Server selection uses only each test's direct imports, never dependency
 * closures, launcher arguments, fixture literals or dynamic-loader guesses.
 * Unknown paths still get related tests; selection errors fail the hook.
 */
import { fromFileUrl, toFileUrl } from "@std/path";

export const STATIC_GATES = [
  "install",
  "lint",
  "check",
  "format",
  "worker",
  "handlers",
  "shell",
  "e2e-modules",
  "contracts",
] as const;
export const GATE_ORDER = [
  ...STATIC_GATES,
  "server",
  "timing",
  "client",
] as const;
export type Gate = typeof GATE_ORDER[number];

export const CONTRACT_TESTS = [
  "tests/test_isolation_contract_test.ts",
  "tests/devcontainer_caps_test.ts",
];

/** Directory entries end with "/". These select static gates only. */
export const SHARED_INPUTS = [
  "deno.json",
  "deno.lock",
  "vite.config.js",
  "vitest.config.mjs",
  ".devcontainer/",
  "scripts/gates.sh",
  "scripts/select-checks.ts",
  "entrypoint.sh",
  "Dockerfile",
];

const TEST_FILE = /(^|\/)([^/]*[_.])?test\.(ts|tsx|mts|js|mjs|jsx)$/;
export interface Change {
  status: string;
  path: string;
  /** Deletion or rename source: still classify the old path. */
  removed: boolean;
}
export interface Context {
  files: string[];
  /** Test file -> resolved, direct, repository-local imports. */
  imports: Record<string, string[]>;
}
export interface Reason {
  path: string;
  status: string;
  rule: string;
  selects: string;
}
export interface Selection {
  version: 1;
  gates: Gate[];
  browser: false;
  contractTests: string[];
  serverTests: string[];
  timingTests: string[];
  /** Changed files passed to `vitest related`. */
  clientTests: string[];
  browserCases: string[];
  reasons: Reason[];
}

/** Parse `git diff --cached --name-status -M -z`. */
export function parseNameStatus(text: string): Change[] {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!/^[ACDMRTUX]\d*$/.test(status)) {
      throw new Error(
        `unexpected name-status field: ${JSON.stringify(status)}`,
      );
    }
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const [from, to] = [fields[i++], fields[i++]];
      if (!from || !to) throw new Error("truncated name-status input");
      changes.push({ status, path: from, removed: kind === "R" });
      changes.push({ status, path: to, removed: false });
    } else {
      const path = fields[i++];
      if (!path) throw new Error("truncated name-status input");
      changes.push({ status, path, removed: kind === "D" });
    }
  }
  return changes;
}

function isTimingPath(path: string): boolean {
  return path.startsWith("tests/timing/");
}
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}
function isServerTest(path: string): boolean {
  return path.startsWith("tests/") && !isTimingPath(path) && isTestFile(path);
}
function isDocs(path: string): boolean {
  return path.endsWith(".md") || path.startsWith("docs/");
}
function isSharedInput(path: string): boolean {
  return SHARED_INPUTS.some((input) =>
    input.endsWith("/") ? path.startsWith(input) : path === input
  );
}

export function selectChecks(changes: Change[], context: Context): Selection {
  const tracked = new Set(context.files);
  const serverTests = context.files.filter(isServerTest);
  const server = new Set<string>();
  const timing = new Set<string>();
  const client = new Set<string>();
  const reasons: Reason[] = [{
    path: "*",
    status: "",
    rule: "always",
    selects: "whole-tree static gates, contract tests and e2e module-load gate",
  }];
  const note = (change: Change, rule: string, selects: string) =>
    reasons.push({ path: change.path, status: change.status, rule, selects });

  for (const change of changes) {
    const path = change.path;
    if (isDocs(path)) {
      note(change, "docs", "static gates only");
      continue;
    }
    if (isSharedInput(path)) {
      note(
        change,
        "shared input",
        "static gates only, with deno install --frozen",
      );
      continue;
    }
    if (isTimingPath(path)) {
      if (isTestFile(path) && !change.removed && tracked.has(path)) {
        timing.add(path);
        note(change, "timing", "this changed timing test, serially");
      } else {
        note(
          change,
          "timing",
          "static gates only; no surviving timing test changed",
        );
      }
      continue;
    }

    const related = serverTests.filter((test) => {
      const imports = context.imports[test];
      if (!imports) throw new Error(`missing direct imports for ${test}`);
      return test === path || imports.includes(path);
    });
    for (const test of related) server.add(test);
    note(
      change,
      "direct imports",
      related.length
        ? `changed server tests or direct importers: ${related.join(", ")}`
        : "no changed server test or direct server-test importer",
    );

    if (path.startsWith("client/") || path.startsWith("shared/")) {
      client.add(path);
      note(change, "client/shared", "vitest related");
    } else if (!path.startsWith("server/") && !path.startsWith("tests/")) {
      client.add(path);
      note(
        change,
        "unknown path",
        "static gates plus direct server importers and vitest related",
      );
    }
  }
  reasons.push({
    path: "*",
    status: "",
    rule: "scope",
    selects:
      "CI owns the browser suite, client build and cold-load; timing tests run here only when the test file changed",
  });
  const gates = new Set<Gate>(STATIC_GATES);
  if (server.size) gates.add("server");
  if (timing.size) gates.add("timing");
  if (client.size) gates.add("client");
  return {
    version: 1,
    gates: GATE_ORDER.filter((gate) => gates.has(gate)),
    browser: false,
    contractTests: CONTRACT_TESTS.filter((test) => tracked.has(test)),
    serverTests: serverTests.filter((test) => server.has(test)),
    timingTests: [...timing].sort(),
    clientTests: [...client].sort(),
    browserCases: [],
    reasons,
  };
}

interface InfoModule {
  specifier: string;
  error?: string;
  dependencies?: {
    code?: { specifier?: string };
    type?: { specifier?: string };
  }[];
}

/** Resolve imports with Deno, but retain only the edges out of test files.
 * The graph's transitive modules are never used to select tests.
 */
export async function loadContext(
  root: string,
  files: string[],
  changes: Change[],
): Promise<Context> {
  const context: Context = { files, imports: {} };
  if (
    changes.every((change) =>
      isDocs(change.path) || isSharedInput(change.path) ||
      isTimingPath(change.path)
    )
  ) return context;
  const tests = files.filter(isServerTest);
  if (!tests.length) return context;
  const rootUrl = toFileUrl(root.endsWith("/") ? root : root + "/");
  const toUrl = (file: string) =>
    new URL(file.split("/").map(encodeURIComponent).join("/"), rootUrl);
  const entry = await Deno.makeTempFile({
    prefix: "select-checks-",
    suffix: ".ts",
  });
  try {
    await Deno.writeTextFile(
      entry,
      tests.map((file) => `import ${JSON.stringify(toUrl(file).href)};\n`).join(
        "",
      ),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", `--config=${root}/deno.json`, entry],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `deno info failed: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    const info = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      modules: InfoModule[];
    };
    const relative = (specifier?: string) => {
      if (!specifier?.startsWith(rootUrl.href)) return undefined;
      return fromFileUrl(specifier).slice(fromFileUrl(rootUrl).length);
    };
    for (const module of info.modules) {
      if (module.error) throw new Error(`${module.specifier}: ${module.error}`);
      const path = relative(module.specifier);
      if (!path || !isServerTest(path)) continue;
      const imports = new Set<string>();
      for (const dependency of module.dependencies ?? []) {
        for (
          const target of [
            dependency.code?.specifier,
            dependency.type?.specifier,
          ]
        ) {
          const resolved = relative(target);
          if (resolved) imports.add(resolved);
        }
      }
      context.imports[path] = [...imports].sort();
    }
    for (const test of tests) {
      if (!context.imports[test]) throw new Error(`deno info omitted ${test}`);
    }
    return context;
  } finally {
    await Deno.remove(entry);
  }
}

/** Reject malformed selections and CI-only gates before any workload runs. */
export function validateSelection(value: unknown): asserts value is Selection {
  const fail = (detail: string): never => {
    throw new Error(`invalid selection: ${detail}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("expected an object");
  }
  const selection = value as Record<string, unknown>;
  if (selection.version !== 1) fail("unsupported version");
  const strings = (name: string): string[] => {
    const list = selection[name];
    if (
      !Array.isArray(list) ||
      list.some((item) =>
        typeof item !== "string" || !item || /[\r\n\0]/.test(item)
      )
    ) fail(`${name} must be a list of nonempty lines`);
    return list as string[];
  };
  const gates = strings("gates");
  if (
    gates.some((gate) => !GATE_ORDER.includes(gate as Gate)) ||
    new Set(gates).size !== gates.length ||
    STATIC_GATES.some((gate) => !gates.includes(gate))
  ) fail("unknown, repeated or missing static gates");
  if (selection.browser !== false || strings("browserCases").length) {
    fail("browser suite is CI-only");
  }
  strings("contractTests");
  for (
    const [field, gate] of [
      ["serverTests", "server"],
      ["timingTests", "timing"],
      ["clientTests", "client"],
    ]
  ) {
    if (gates.includes(gate) !== (strings(field).length > 0)) {
      fail(`${field} disagrees with gates`);
    }
  }
  if (!Array.isArray(selection.reasons) || !selection.reasons.length) {
    fail("missing reasons");
  }
  for (const reason of selection.reasons as Record<string, unknown>[]) {
    if (
      !reason ||
      ["path", "status", "rule", "selects"].some((key) =>
        typeof reason[key] !== "string"
      )
    ) fail("malformed reason");
  }
}

function printField(selection: Selection, field: string): void {
  const value = (selection as unknown as Record<string, unknown>)[field];
  if (!Object.hasOwn(selection, field) || value === undefined) {
    throw new Error(`unknown selection field: ${field}`);
  }
  for (const item of Array.isArray(value) ? value : [value]) {
    console.log(String(item));
  }
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "--field" && args.length === 3) {
    const selection: unknown = JSON.parse(await Deno.readTextFile(args[1]));
    validateSelection(selection);
    return printField(selection, args[2]);
  }
  if (args.length !== 4 || args[0] !== "--staged" || args[2] !== "--files") {
    throw new Error(
      "usage: select-checks.ts --staged NAME-STATUS-Z --files LS-TREE-Z | --field SELECTION FIELD",
    );
  }
  const changes = parseNameStatus(await Deno.readTextFile(args[1]));
  const files = (await Deno.readTextFile(args[3])).split("\0").filter(Boolean);
  const selection = selectChecks(
    changes,
    await loadContext(Deno.cwd(), files, changes),
  );
  validateSelection(selection);
  console.log(JSON.stringify(selection, null, 2));
}

if (import.meta.main) await main(Deno.args);
