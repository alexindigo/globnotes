// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Commit-check selection: staged paths → the checks the pre-commit hook runs
 * (docs/testing.md). It runs inside the devcontainer, on the exact snapshot
 * of the staged tree, as `scripts/gates.sh --plan`.
 *
 * When in doubt, select more. A path no rule classifies selects the
 * shared-input set; a dependency the analysis cannot see (a removed path, an
 * unclassified dynamic import, a missing graph or case map) selects
 * everything it could hide. Every choice is recorded with its reason.
 *
 * | # | Changed path                                  | Selected |
 * |---|-----------------------------------------------|----------|
 * | 1 | any change                                    | static gates and the contract tests |
 * | 2 | server/**, shared/**, tests/** (not timing)   | server tests whose dependencies contain it |
 * | 3 | client/** (not e2e), shared/**                | related client tests, build, cold-load |
 * | 4 | client/tests/e2e/**                           | the browser cases and meta gates that reach it |
 * | 5 | shared inputs (SHARED_INPUTS)                 | every non-browser check; .devcontainer/** also the browser suite |
 * | 6 | tests/timing/**                               | those timing tests, serially |
 * | 7 | docs (*.md, docs/**)                          | row 1 |
 * | 8 | anything else                                 | row 5 |
 * | 9 | renames and deletions                         | old and new paths are both classified |
 *
 * A test's dependencies are its module graph (`deno info`) plus the
 * repository paths its modules name in string literals (`new URL("…",
 * import.meta.url)`, launcher arguments, fixture files), followed
 * transitively. A directory named relative to a module is a loader: its
 * modules are dependencies too. Any other named directory (the repository
 * root as a launcher's working directory, a whole-tree scan, a root-relative
 * name) counts for server-side paths only. A path a server test's
 * dependencies contain selects that test, whatever the path's row.
 */

import { fromFileUrl, toFileUrl } from "@std/path";

export const GATE_ORDER = [
  "install",
  "lint",
  "check",
  "format",
  "worker",
  "handlers",
  "shell",
  "e2e-modules",
  "contracts",
  "server",
  "timing",
  "client",
  "build",
  "cold-load",
  "unit-controls",
  "native",
  "native-results",
  "native-controls",
  "entrypoint-results",
] as const;
export type Gate = typeof GATE_ORDER[number];

export const STATIC_GATES: Gate[] = [
  "install",
  "lint",
  "check",
  "format",
  "worker",
  "handlers",
  "shell",
  "e2e-modules",
  "contracts",
];
export const BROWSER_GATES: Gate[] = [
  "native",
  "native-results",
  "native-controls",
  "entrypoint-results",
];

/** Row 1: always run, when the tree has them. */
export const CONTRACT_TESTS = [
  "tests/test_isolation_contract_test.ts",
  "tests/devcontainer_caps_test.ts",
];

/** Row 5. A directory entry ends with "/". */
export const SHARED_INPUTS = [
  "deno.json",
  "deno.lock",
  "vite.config.js",
  "vitest.config.mjs",
  ".devcontainer/",
  "scripts/gates.sh",
  "scripts/select-checks.ts",
  "scripts/cold-load.mjs",
  "entrypoint.sh",
  "Dockerfile",
];

export const E2E = "client/tests/e2e/";
const SUITE_ENTRY = E2E + "legacy-native-suite.mjs";
/** Browser-suite meta gates and the entrypoint each one runs. */
export const META_ENTRIES: Record<string, Gate> = {
  [E2E + "native-result-controls.mjs"]: "native-results",
  [E2E + "unit-consumer-controls.mjs"]: "unit-controls",
  [E2E + "runner-entrypoint-controls.mjs"]: "entrypoint-results",
};

/**
 * Dynamic loading sites the literal scan cannot resolve, and what they load.
 * A module with a site that is not listed here (or with a different number of
 * sites) depends on everything.
 */
export const KNOWN_DYNAMIC: Record<
  string,
  { sites: number; loads: string[]; why: string }
> = {
  "server/plugins/host.ts": {
    sites: 1,
    loads: [],
    why: "the Worker URL (WORKER_URL) is a literal in the same module",
  },
  "server/plugins/worker_entry.ts": {
    sites: 2,
    loads: ["plugins/"],
    why:
      "plugin entry and endpoint modules: bundled plugins or test-written fixtures",
  },
  "tests/http_mutation_lease_test.ts": {
    sites: 2,
    loads: [],
    why:
      "endpoint(relative): the endpoint paths are literals in the same module",
  },
  "tests/plugin_render_lifecycle_test.ts": {
    sites: 1,
    loads: [],
    why: "enabledUrl is a literal URL in the same module",
  },
  "tests/plugin_network_api_test.ts": {
    sites: 2,
    loads: [],
    why: "remote modules served by the test's own HTTP fixture",
  },
  [SUITE_ENTRY]: {
    sites: 1,
    loads: [],
    why: "case drivers named by SELECTION, mapped by FILE_CASES",
  },
  "scripts/select-checks.ts": {
    sites: 1,
    loads: [SUITE_ENTRY],
    why: "the snapshot's case map",
  },
};

const DYNAMIC_SITE =
  /\bimport\((?!\s*["'`]|\s*new URL\(\s*["'`])|new URL\(\s*(?!["'`\s])[^,()]*,\s*import\.meta\.url|new Worker\(\s*(?!["'`\s])/g;
const RELATIVE_LITERAL = /["'`](\.\.?\/[^"'`\s$]*)["'`]/g;
const ROOT_LITERAL =
  /["'`](?!\.{1,2}\/)([^"'`\s$:/][^"'`\s$:]*\/[^"'`\s$:]*)["'`]/g;
const MODULE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const TEST_FILE = /(^|\/)([^/]*[_.])?test\.(ts|tsx|mts|js|mjs|jsx)$/;

export interface Change {
  status: string;
  path: string;
  /** The path no longer exists in the snapshot (deletion, rename source). */
  removed: boolean;
}

/** What one module refers to, as repository-relative paths. */
export interface ModuleRefs {
  imports: string[];
  /** Literal paths: files, or directories ending with "/" ("" = the root). */
  literals: string[];
  /** Literal directories, relative to the module, whose modules it loads.
   * Other directory literals (the root, root-relative names) are working
   * directories or scans: they count for server-side paths only. */
  loaders: string[];
  /** Unclassified dynamic loading sites. */
  unknownDynamic: number;
}

export interface CaseMap {
  /** Case ids in suite order. */
  all: string[];
  /** Case id → its driver file. */
  drivers: Record<string, string>;
  /** P10 map: file → case ids. */
  fileCases: Record<string, string[]>;
  sharedFiles: string[];
}

export interface Context {
  /** Tracked paths of the snapshot. */
  files: string[];
  /** Module → references; null when the graph could not be built. */
  refs: Record<string, ModuleRefs> | null;
  graphError?: string;
  cases: CaseMap | null;
  caseError?: string;
  /** Vitest setup files (vitest.config.mjs): every client test loads them. */
  clientSetup: string[];
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
  browser: boolean;
  contractTests: string[];
  serverTests: "all" | string[];
  timingTests: "all" | string[];
  /** "all" or the changed files given to `vitest related`. */
  clientTests: "all" | string[];
  browserCases: "all" | string[];
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
      if (from === undefined || to === undefined) throw new Error("truncated");
      changes.push({ status, path: from, removed: kind === "R" });
      changes.push({ status, path: to, removed: false });
    } else {
      const path = fields[i++];
      if (path === undefined) throw new Error("truncated name-status input");
      changes.push({ status, path, removed: kind === "D" });
    }
  }
  return changes;
}

function isTimingPath(path: string): boolean {
  return path.startsWith("tests/timing/");
}

function isServerSide(path: string): boolean {
  return path.startsWith("server/") || path.startsWith("shared/") ||
    (path.startsWith("tests/") && !isTimingPath(path));
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function hasBrowserGate(gates: Set<Gate>): boolean {
  return BROWSER_GATES.some((gate) => gates.has(gate));
}

function isDocs(path: string): boolean {
  return path.endsWith(".md") || path.startsWith("docs/");
}

function isSharedInput(path: string): boolean {
  return SHARED_INPUTS.some((input) =>
    input.endsWith("/") ? path.startsWith(input) : path === input
  );
}

interface Closure {
  /** Paths named or imported, transitively (loader directories expanded). */
  files: Set<string>;
  /** Other named directories ("" = the repository root). */
  dirs: Set<string>;
  /** Modules with unclassified dynamic loading sites. */
  unknown: string[];
}

/** Dependency closures, memoized per context. */
class Graph {
  #memo = new Map<string, Closure>();
  constructor(
    readonly refs: Record<string, ModuleRefs>,
    readonly files: string[],
  ) {}

  closure(entry: string): Closure {
    const cached = this.#memo.get(entry);
    if (cached) return cached;
    const result: Closure = { files: new Set(), dirs: new Set(), unknown: [] };
    const visited = new Set<string>();
    const queue = [entry];
    const addDirectory = (directory: string, loader: boolean) => {
      if (!loader) {
        result.dirs.add(directory);
        return;
      }
      for (const file of this.files) {
        if (!file.startsWith(directory)) continue;
        result.files.add(file);
        if (MODULE.test(file)) queue.push(file);
      }
    };
    while (queue.length) {
      const module = queue.pop()!;
      if (visited.has(module)) continue;
      visited.add(module);
      result.files.add(module);
      const refs = this.refs[module];
      if (!refs) continue;
      if (refs.unknownDynamic) result.unknown.push(module);
      for (const target of refs.imports) queue.push(target);
      for (const literal of refs.literals) {
        if (literal === "" || literal.endsWith("/")) {
          addDirectory(literal, refs.loaders.includes(literal));
        } else {
          result.files.add(literal);
          if (MODULE.test(literal)) queue.push(literal);
        }
      }
    }
    this.#memo.set(entry, result);
    return result;
  }

  /** Does `entry` depend on `path`? Named directories count for
   * server-side paths only. */
  reaches(entry: string, path: string): boolean {
    const closure = this.closure(entry);
    return closure.files.has(path) || closure.unknown.length > 0 ||
      (isServerSide(path) &&
        [...closure.dirs].some((directory) => path.startsWith(directory)));
  }
}

const graphs = new WeakMap<Context, Graph>();
function graphOf(context: Context): Graph | null {
  if (!context.refs) return null;
  let graph = graphs.get(context);
  if (!graph) {
    graph = new Graph(context.refs, context.files);
    graphs.set(context, graph);
  }
  return graph;
}

interface Picked {
  server: Set<string> | "all";
  timing: Set<string> | "all";
  client: Set<string> | "all";
  cases: Set<string> | "all";
}

/** The pure selection: §3.1 of the commit-check plan, rows 1–9. */
export function selectChecks(changes: Change[], context: Context): Selection {
  const tracked = new Set(context.files);
  const reasons: Reason[] = [];
  const graph = graphOf(context);
  const serverTestFiles = context.files.filter((file) =>
    file.startsWith("tests/") && !isTimingPath(file) && isTestFile(file)
  );
  const timingTestFiles = context.files.filter((file) =>
    isTimingPath(file) && isTestFile(file)
  );

  const picked: Picked = {
    server: new Set(),
    timing: new Set(),
    client: new Set(),
    cases: new Set(),
  };
  const gates = new Set<Gate>(STATIC_GATES);
  const note = (change: Change, rule: string, selects: string) =>
    reasons.push({ path: change.path, status: change.status, rule, selects });

  const allServer = (change: Change, rule: string, why: string) => {
    picked.server = "all";
    note(change, rule, `whole server suite: ${why}`);
  };
  const addServer = (tests: string[]) => {
    if (picked.server !== "all") {
      for (const test of tests) picked.server.add(test);
    }
  };
  const allClient = (change: Change, rule: string, why: string) => {
    picked.client = "all";
    gates.add("build");
    gates.add("unit-controls");
    note(change, rule, `whole client suite, build, cold-load: ${why}`);
  };
  const nonBrowser = (change: Change, rule: string, why: string) => {
    allServer(change, rule, why);
    allClient(change, rule, why);
  };
  const wholeBrowser = (change: Change, rule: string, why: string) => {
    picked.cases = "all";
    for (const gate of BROWSER_GATES) gates.add(gate);
    gates.add("unit-controls");
    gates.add("build");
    note(change, rule, `whole browser suite: ${why}`);
  };

  /** Server tests that name this path (any row; select more). */
  const referencingTests = (change: Change) => {
    if (!graph || change.removed || picked.server === "all") return;
    const tests = serverTestFiles.filter((test) =>
      graph.closure(test).files.has(change.path)
    );
    if (!tests.length) return;
    addServer(tests);
    note(change, "references", `server tests naming it: ${tests.join(", ")}`);
  };

  const graphServer = (change: Change) => {
    if (!graph) {
      return allServer(
        change,
        "row 2",
        `no dependency graph (${context.graphError ?? "unavailable"})`,
      );
    }
    if (change.removed) {
      return allServer(
        change,
        "row 2/9",
        "removed path; its dependents are not in the snapshot",
      );
    }
    const tests = serverTestFiles.filter((test) =>
      graph.reaches(test, change.path)
    );
    addServer(tests);
    note(
      change,
      "row 2",
      tests.length
        ? `server tests reaching it: ${tests.length}`
        : "no server test reaches it (type check and lint still cover it)",
    );
  };

  const relatedClient = (change: Change, rule: string) => {
    if (change.removed) {
      return allClient(
        change,
        `${rule}/9`,
        "removed path; related tests cannot be traced",
      );
    }
    if (context.clientSetup.includes(change.path)) {
      return allClient(
        change,
        rule,
        "vitest setup file, loaded by every client test",
      );
    }
    if (picked.client !== "all") picked.client.add(change.path);
    note(change, rule, "vitest related");
  };

  const browserPath = (change: Change) => {
    const map = context.cases;
    if (!map) {
      return wholeBrowser(
        change,
        "row 4",
        `no case map (${context.caseError ?? "unavailable"})`,
      );
    }
    if (!graph) {
      return wholeBrowser(change, "row 4", "no dependency graph");
    }
    if (change.removed) {
      return wholeBrowser(change, "row 4/9", "removed browser file");
    }
    if (isTestFile(change.path)) {
      relatedClient(change, "row 4 (client test)");
      return;
    }
    if (MODULE.test(change.path)) {
      relatedClient(change, "row 4 (client tests importing it)");
    }
    if (map.sharedFiles.includes(change.path)) {
      return wholeBrowser(change, "row 4", "shared harness file");
    }
    if (
      graph && graph.reaches(SUITE_ENTRY, change.path) &&
      change.path !== SUITE_ENTRY
    ) {
      return wholeBrowser(
        change,
        "row 4",
        "imported by the native suite itself",
      );
    }
    const found = new Set(map.fileCases[change.path] ?? []);
    if (graph) {
      for (const id of map.all) {
        const driver = map.drivers[id];
        if (driver && graph.closure(driver).unknown.length) {
          return wholeBrowser(
            change,
            "row 4",
            `unclassified dynamic import under ${driver}`,
          );
        }
        if (driver && graph.closure(driver).files.has(change.path)) {
          found.add(id);
        }
      }
    }
    const meta = graph
      ? Object.entries(META_ENTRIES).filter(([entry]) =>
        graph.reaches(entry, change.path)
      ).map(([, gate]) => gate)
      : [];
    if (!found.size && !meta.length) {
      if (graph && context.refs![change.path]) {
        note(change, "row 4", "no browser gate reaches this module");
        return;
      }
      return wholeBrowser(
        change,
        "row 4",
        "browser file outside the case map and graph",
      );
    }
    if (found.size) {
      if (picked.cases !== "all") {
        for (const id of found) picked.cases.add(id);
      }
      gates.add("native");
      gates.add("native-controls");
      gates.add("build");
    }
    for (const gate of meta) gates.add(gate);
    note(
      change,
      "row 4",
      [found.size ? `cases ${[...found].join(", ")}` : "", meta.join(", ")]
        .filter(Boolean).join("; "),
    );
  };

  for (const change of changes) {
    const path = change.path;
    if (isDocs(path)) {
      note(change, "row 7", "static gates only");
      referencingTests(change);
      continue;
    }
    if (isSharedInput(path)) {
      nonBrowser(change, "row 5", "shared input");
      if (path.startsWith(".devcontainer/")) {
        wholeBrowser(change, "row 5", "devcontainer");
      }
      continue;
    }
    if (isTimingPath(path)) {
      if (!change.removed && isTestFile(path) && picked.timing !== "all") {
        picked.timing.add(path);
        note(change, "row 6", "this timing test, serially");
      } else {
        picked.timing = "all";
        note(
          change,
          "row 6",
          "all timing tests (helper or removed timing file)",
        );
      }
      continue;
    }
    let classified = false;
    if (isServerSide(path)) {
      graphServer(change);
      classified = true;
    }
    if (path.startsWith(E2E)) {
      browserPath(change);
      classified = true;
    } else if (path.startsWith("client/") || path.startsWith("shared/")) {
      relatedClient(change, "row 3");
      gates.add("build");
      gates.add("unit-controls");
      classified = true;
    }
    if (!classified) {
      nonBrowser(change, "row 8", "unclassified path");
      continue;
    }
    if (!isServerSide(path)) referencingTests(change);
  }

  const contractTests = CONTRACT_TESTS.filter((test) => tracked.has(test));
  const serverList = picked.server === "all"
    ? "all"
    : serverTestFiles.filter((test) =>
      (picked.server as Set<string>).has(test)
    );
  if (serverList === "all" || serverList.length) gates.add("server");
  const timingList = picked.timing === "all"
    ? "all"
    : timingTestFiles.filter((test) =>
      (picked.timing as Set<string>).has(test)
    );
  if (timingList === "all" || timingList.length) gates.add("timing");
  const clientList = picked.client === "all"
    ? "all"
    : [...picked.client].sort();
  if (clientList === "all" || clientList.length) gates.add("client");
  if (gates.has("build")) gates.add("cold-load");
  if (
    !hasBrowserGate(gates) && changes.some((change) => !isDocs(change.path))
  ) {
    reasons.push({
      path: "*",
      status: "",
      rule: "scope",
      selects:
        "browser cases run in pre-commit only for client/tests/e2e/** and .devcontainer/** changes; CI runs the whole browser suite",
    });
  }
  if (
    picked.timing !== "all" && !picked.timing.size &&
    changes.some((change) => isServerSide(change.path))
  ) {
    reasons.push({
      path: "*",
      status: "",
      rule: "scope",
      selects:
        "timing tests run in pre-commit only for tests/timing/** changes; CI runs them",
    });
  }
  const caseList = picked.cases === "all"
    ? "all"
    : (context.cases?.all ?? []).filter((id) =>
      (picked.cases as Set<string>).has(id)
    );
  const ordered = GATE_ORDER.filter((gate) => gates.has(gate));
  return {
    version: 1,
    gates: ordered,
    browser: ordered.some((gate) => BROWSER_GATES.includes(gate)),
    contractTests,
    serverTests: serverList,
    timingTests: timingList,
    clientTests: clientList,
    browserCases: caseList,
    reasons,
  };
}

/** Repository-relative path of a literal, or undefined. */
function resolveLiteral(
  module: string,
  literal: string,
  relative: boolean,
  tracked: Set<string>,
  directories: Set<string>,
): string | undefined {
  let decoded = literal;
  try {
    decoded = decodeURIComponent(literal);
  } catch { /* keep the raw literal */ }
  const parts = relative ? module.split("/").slice(0, -1) : [];
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join("/");
  if (tracked.has(path)) return path;
  if (path === "") return relative ? "" : undefined;
  if (directories.has(path)) return path + "/";
  return undefined;
}

/** Literal references and dynamic sites of one module's source text. */
export function scanModule(
  module: string,
  text: string,
  tracked: Set<string>,
  directories: Set<string>,
): Omit<ModuleRefs, "imports"> {
  const literals = new Set<string>();
  const loaders = new Set<string>();
  for (const [, literal] of text.matchAll(RELATIVE_LITERAL)) {
    const path = resolveLiteral(module, literal, true, tracked, directories);
    if (path === undefined) continue;
    literals.add(path);
    if (path.endsWith("/")) loaders.add(path);
  }
  for (const [, literal] of text.matchAll(ROOT_LITERAL)) {
    const path = resolveLiteral(module, literal, false, tracked, directories);
    if (path !== undefined) literals.add(path);
  }
  const sites = [...text.matchAll(DYNAMIC_SITE)].length;
  const known = KNOWN_DYNAMIC[module];
  let unknownDynamic = sites;
  if (known && known.sites === sites) {
    unknownDynamic = 0;
    for (const load of known.loads) {
      literals.add(load);
      loaders.add(load);
    }
  }
  return {
    literals: [...literals].sort(),
    loaders: [...loaders].sort(),
    unknownDynamic,
  };
}

function directoriesOf(files: string[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join("/"));
    }
  }
  return directories;
}

const GRAPH_ROOTS = [
  "server/",
  "shared/",
  "tests/",
  "scripts/",
  "plugins/",
  E2E,
];

interface InfoModule {
  specifier: string;
  error?: string;
  dependencies?: {
    code?: { specifier?: string };
    type?: { specifier?: string };
  }[];
}

/** Module graph of every tracked module in GRAPH_ROOTS, via `deno info`. */
async function moduleGraph(
  root: string,
  files: string[],
): Promise<Record<string, ModuleRefs>> {
  const tracked = new Set(files);
  const directories = directoriesOf(files);
  const modules = files.filter((file) =>
    MODULE.test(file) && GRAPH_ROOTS.some((prefix) => file.startsWith(prefix))
  );
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
      modules.map((file) => `import ${JSON.stringify(toUrl(file).href)};\n`)
        .join(""),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", `--config=${root}/deno.json`, entry],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `deno info failed: ${
          new TextDecoder().decode(output.stderr).slice(0, 2000)
        }`,
      );
    }
    const info = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      modules: InfoModule[];
    };
    const prefix = rootUrl.href;
    const relative = (specifier?: string) => {
      if (!specifier?.startsWith(prefix)) return undefined;
      const path = fromFileUrl(specifier).slice(fromFileUrl(prefix).length);
      return tracked.has(path) ? path : undefined;
    };
    const refs: Record<string, ModuleRefs> = {};
    for (const module of info.modules) {
      const path = relative(module.specifier);
      if (!path) continue;
      if (module.error) throw new Error(`${path}: ${module.error}`);
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
      const text = await Deno.readTextFile(`${root}/${path}`);
      refs[path] = {
        imports: [...imports].sort(),
        ...scanModule(path, text, tracked, directories),
      };
    }
    for (const module of modules) {
      if (!refs[module]) throw new Error(`deno info omitted ${module}`);
    }
    return refs;
  } finally {
    await Deno.remove(entry);
  }
}

async function caseMap(root: string): Promise<CaseMap> {
  const suite = await import(toFileUrl(`${root}/${SUITE_ENTRY}`).href);
  const { SELECTION, FILE_CASES, SHARED_CASE_FILES, caseName } = suite;
  if (
    !Array.isArray(SELECTION) || typeof FILE_CASES !== "object" ||
    !Array.isArray(SHARED_CASE_FILES) || typeof caseName !== "function"
  ) {
    throw new Error(`${SUITE_ENTRY} does not export the case map`);
  }
  const all = SELECTION.map((selection: string[]) => caseName(selection));
  const drivers: Record<string, string> = {};
  SELECTION.forEach((selection: string[], index: number) => {
    drivers[all[index]] = `${E2E}${selection[0]}.mjs`;
  });
  return {
    all,
    drivers,
    fileCases: FILE_CASES,
    sharedFiles: SHARED_CASE_FILES,
  };
}

async function clientSetup(root: string): Promise<string[]> {
  const config = await Deno.readTextFile(`${root}/vitest.config.mjs`);
  const list = /setupFiles:\s*\[([^\]]*)\]/.exec(config);
  if (!list) throw new Error("vitest.config.mjs: no setupFiles list");
  return [...list[1].matchAll(/["']([^"']+)["']/g)].map(([, file]) => file);
}

/** The impure part: read the snapshot. */
export async function loadContext(
  root: string,
  files: string[],
): Promise<Context> {
  const context: Context = { files, refs: null, cases: null, clientSetup: [] };
  try {
    context.refs = await moduleGraph(root, files);
  } catch (error) {
    context.graphError = String(error);
  }
  try {
    context.cases = await caseMap(root);
  } catch (error) {
    context.caseError = String(error);
  }
  context.clientSetup = await clientSetup(root);
  return context;
}

/** Validate at the producer/consumer boundary, before any fields are printed.
 * Malformed/partial JSON must never be interpreted as fewer checks. */
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
      !Array.isArray(list) || list.some((item) =>
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
  const browser = gates.some((gate) => BROWSER_GATES.includes(gate as Gate));
  if (selection.browser !== browser) fail("browser flag disagrees with gates");
  strings("contractTests");
  for (
    const [field, selected] of [
      ["serverTests", gates.includes("server")],
      ["timingTests", gates.includes("timing")],
      ["clientTests", gates.includes("client")],
      ["browserCases", gates.includes("native") || gates.includes("native-controls")],
    ] as const
  ) {
    const list = selection[field] === "all" ? ["all"] : strings(field);
    if (selected !== (list.length > 0)) fail(`${field} disagrees with gates`);
  }
  if (gates.includes("build") !== gates.includes("cold-load")) {
    fail("build and cold-load must be selected together");
  }
  if (!Array.isArray(selection.reasons)) fail("missing reasons");
}

/** Print a selection field, one value per line (for scripts/gates.sh). */
function printField(selection: Selection, field: string): void {
  const value = (selection as unknown as Record<string, unknown>)[field];
  if (!Object.hasOwn(selection, field) || value === undefined) {
    throw new Error(`unknown selection field: ${field}`);
  }
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) console.log(String(item));
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
  const root = Deno.cwd();
  const changes = parseNameStatus(await Deno.readTextFile(args[1]));
  const files = (await Deno.readTextFile(args[3])).split("\0").filter(Boolean);
  const context = await loadContext(root, files);
  const selection = selectChecks(changes, context);
  validateSelection(selection);
  console.log(JSON.stringify(selection, null, 2));
}

if (import.meta.main) await main(Deno.args);
