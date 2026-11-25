// SPDX-License-Identifier: LGPL-3.0-only
/** Ownership is checked at roots and import sites, never by following values. */
import ts from "typescript";
import * as path from "@std/path";
import { command, DENO } from "./process.ts";

export interface SourceModule {
  file: string;
  text: string;
  /** Original specifier -> Deno-resolved module identity. */
  imports?: Record<string, string>;
}
export interface OwnershipSite {
  file: string;
  capability: string;
  line: number;
  source: string;
  context: string;
}
export interface LegacySite extends OwnershipSite {
  family: string;
  replacement: string;
  consumers: string[];
  allowed?: boolean;
  reason?: string;
}
export interface OwnershipFamily {
  replacement: string;
  consumers: string[];
  closed?: boolean;
  allowed?: boolean;
  reason?: string;
}
export interface RootRule {
  /** Only direct, non-computed members in this list are ordinary public APIs. */
  members: readonly string[];
  /** Overrides members: these members require an exact owner module. */
  ownedMembers?: Readonly<Record<string, readonly string[]>>;
  /** Exact low-level modules allowed to construct the root directly. */
  ownedConstructors?: readonly string[];
  /** Exact low-level modules allowed a non-escaping instanceof RHS. */
  ownedInstanceChecks?: readonly string[];
}
export interface OwnershipRules {
  roots: Readonly<Record<string, RootRule>>;
  /** Resolved module identity -> exact owner modules, for every runtime form. */
  modules: Readonly<Record<string, readonly string[]>>;
  /** Import ownership allows use, but not runtime re-export of these modules. */
  privateExports?: readonly string[];
}
export const CHILD_OWNER = "tests/helpers/process.ts";
const GLOBAL_MEMBERS = [
  "Worker",
  "crypto",
  "addEventListener",
  "removeEventListener",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
  "postMessage",
  "onmessage",
];
export const PROCESS_OWNERSHIP: OwnershipRules = {
  roots: {
    Deno: {
      members: [
        "SeekMode",
        "args",
        "build",
        "chmod",
        "chmodSync",
        "chownSync",
        "connect",
        "copyFile",
        "copyFileSync",
        "createHttpClient",
        "cwd",
        "env",
        "errors",
        "execPath",
        "linkSync",
        "listen",
        "lstat",
        "lstatSync",
        "makeTempDir",
        "makeTempDirSync",
        "makeTempFile",
        "makeTempFileSync",
        "mkdir",
        "mkdirSync",
        "networkInterfaces",
        "open",
        "openSync",
        "permissions",
        "pid",
        "ppid",
        "readDir",
        "readDirSync",
        "readFile",
        "readFileSync",
        "readLink",
        "readLinkSync",
        "readTextFile",
        "readTextFileSync",
        "realPath",
        "realPathSync",
        "remove",
        "removeSync",
        "rename",
        "renameSync",
        "serve",
        "stat",
        "statSync",
        "stderr",
        "stdin",
        "stdout",
        "symlink",
        "symlinkSync",
        "test",
        "utime",
        "utimeSync",
        "version",
        "watchFs",
        "writeFile",
        "writeFileSync",
        "writeTextFile",
        "writeTextFileSync",
      ],
      ownedMembers: {
        Command: [CHILD_OWNER],
        run: [CHILD_OWNER],
        kill: [CHILD_OWNER],
        exit: [
          "server/main.ts",
          "server/config/cli.ts",
          "server/auth/local.ts",
        ],
        addSignalListener: ["server/main.ts"],
        removeSignalListener: ["server/main.ts"],
      },
    },
    globalThis: { members: GLOBAL_MEMBERS },
    self: { members: GLOBAL_MEMBERS },
    window: { members: GLOBAL_MEMBERS },
    global: { members: GLOBAL_MEMBERS },
    module: { members: [] },
    process: {
      members: [
        "cwd",
        "env",
        "pid",
        "ppid",
        "platform",
        "versions",
        "version",
        "arch",
        "argv",
        "execPath",
        "stdout",
        "stderr",
        "stdin",
      ],
    },
    require: { members: [] },
    eval: { members: [] },
    Function: { members: [] },
  },
  modules: {
    "node:child_process": [CHILD_OWNER],
    "node:module": [CHILD_OWNER],
    "node:process": [CHILD_OWNER],
  },
};

/** A full-span wrapper alone cannot authorize an omitted statement suffix. */
export function assertOwnershipParse(
  ast: ts.SourceFile,
  text: string,
  diagnostics: readonly ts.Diagnostic[] = [],
): void {
  const fail = (reason: string): never => {
    throw new Error(`ownership parse: ${ast.fileName}: ${reason}`);
  };
  if (diagnostics.length) {
    fail(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n"));
  }
  if (
    ast.text !== text || ast.pos !== 0 || ast.end !== text.length ||
    ast.endOfFileToken.end !== text.length
  ) fail("incomplete source span");
  let end = 0;
  for (const statement of ast.statements) {
    if (
      statement.pos !== end || statement.end <= end ||
      statement.end > text.length
    ) fail("incomplete statement span");
    end = statement.end;
  }
  if (ast.endOfFileToken.pos !== end) fail("incomplete EOF span");
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    text.slice(end),
  );
  if (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    fail("unchecked source suffix");
  }
}

// Closed erasure boundaries, not isTypeNode: mixed runtime/type nodes (including
// class heritage) must never authorize skipping an unknown expression subtree.
const TYPE_ANNOTATION_PARENTS = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.CallSignature,
  ts.SyntaxKind.ConstructSignature,
  ts.SyntaxKind.IndexSignature,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.SatisfiesExpression,
]);
const TYPE_ARGUMENT_PARENTS = new Set([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.ExpressionWithTypeArguments,
  ts.SyntaxKind.JsxOpeningElement,
  ts.SyntaxKind.JsxSelfClosingElement,
]);
function isErasedPosition(node: ts.Node): boolean {
  for (
    let child = node, parent: ts.Node | undefined = node;
    parent;
    child = parent, parent = parent.parent
  ) {
    switch (parent.kind) {
      case ts.SyntaxKind.SourceFile:
        if ((parent as ts.SourceFile).isDeclarationFile) return true;
        break;
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
      case ts.SyntaxKind.TypeParameter:
        return true;
      case ts.SyntaxKind.HeritageClause:
        if (
          (parent as ts.HeritageClause).token ===
            ts.SyntaxKind.ImplementsKeyword
        ) return true;
        break;
      case ts.SyntaxKind.ImportDeclaration:
        if ((parent as ts.ImportDeclaration).importClause?.isTypeOnly) {
          return true;
        }
        break;
      case ts.SyntaxKind.ImportClause:
      case ts.SyntaxKind.ImportSpecifier:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.ExportSpecifier:
      case ts.SyntaxKind.ImportEqualsDeclaration:
        if (
          (parent as
            | ts.ImportClause
            | ts.ImportSpecifier
            | ts.ExportDeclaration
            | ts.ExportSpecifier
            | ts.ImportEqualsDeclaration).isTypeOnly
        ) return true;
        break;
      case ts.SyntaxKind.VariableStatement:
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.EnumDeclaration:
      case ts.SyntaxKind.ModuleDeclaration:
        if (
          (parent as
            | ts.VariableStatement
            | ts.FunctionDeclaration
            | ts.ClassDeclaration
            | ts.EnumDeclaration
            | ts.ModuleDeclaration).modifiers?.some((m) =>
              m.kind === ts.SyntaxKind.DeclareKeyword
            )
        ) return true;
        break;
    }
    if (
      TYPE_ANNOTATION_PARENTS.has(parent.kind) && "type" in parent &&
      parent.type === child
    ) return true;
    if (
      TYPE_ARGUMENT_PARENTS.has(parent.kind) &&
      (parent as ts.CallExpression).typeArguments?.some((type) =>
        type === child
      )
    ) return true;
  }
  return false;
}

// Only these known name positions are non-value syntax. A future node with a
// field called "name" is not implicitly exempt from protected-root checks.
const NON_VALUE_NAMES = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.NamespaceExport,
  ts.SyntaxKind.JsxAttribute,
]);
const LEXICAL_DECLARATIONS = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
]);
/** Syntax-only reference positions; lexical shadowing is supplied by the compiler. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  for (
    let ancestor: ts.Node | undefined = parent;
    ancestor;
    ancestor = ts.isPropertyAccessExpression(ancestor)
      ? ancestor.parent
      : undefined
  ) {
    if (ts.isJsxClosingElement(ancestor)) return false;
  }
  if (
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
    parent.tagName === node && /^[a-z]/.test(node.text)
  ) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isExportSpecifier(parent)) {
    // External specifiers name module exports, not bindings in this scope.
    if (parent.parent.parent.moduleSpecifier) return false;
    return (parent.propertyName ?? parent.name) === node;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) {
    return false;
  }
  return !(NON_VALUE_NAMES.has(parent.kind) && "name" in parent &&
    parent.name === node);
}
const moduleIdentity = (specifier: string) =>
  ["child_process", "module", "process"].includes(specifier)
    ? `node:${specifier}`
    : specifier;

export function analyzeOwnership(
  sources: SourceModule[],
  rules = PROCESS_OWNERSHIP,
): OwnershipSite[] {
  const expected = COVERAGE.get(sources)?.files ?? sources.map((s) => s.file);
  assertModuleCoverage(expected, sources.map((s) => s.file));
  const inputs = new Map(sources.map((s) => [`/repository/${s.file}`, s]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    allowJs: true,
    noLib: true,
    noResolve: true,
    noEmit: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (file, language) => {
      const input = inputs.get(file);
      return input
        ? ts.createSourceFile(file, input.text, language, true)
        : undefined;
    },
    getDefaultLibFileName: () => "",
    writeFile() {},
    getCurrentDirectory: () => "/repository",
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (file) => inputs.has(file),
    readFile: (file) => inputs.get(file)?.text,
  };
  const program = ts.createProgram([...inputs.keys()], options, host),
    checker = program.getTypeChecker();
  assertModuleCoverage(
    expected,
    program.getSourceFiles().map((ast) => inputs.get(ast.fileName)!.file),
  );
  const sites: OwnershipSite[] = [];
  for (const ast of program.getSourceFiles()) {
    const input = inputs.get(ast.fileName)!;
    assertOwnershipParse(ast, input.text, program.getSyntacticDiagnostics(ast));
    const report = (node: ts.Node, capability: string) => {
      const start = node.getStart(ast),
        line = ast.getLineAndCharacterOfPosition(start).line + 1;
      sites.push({
        file: input.file,
        capability,
        line,
        source: input.text.slice(start, node.end),
        context: input.text.split("\n")[line - 1].trim(),
      });
    };
    const dependency = (
      node: ts.Expression,
      kind: "import" | "dynamic" | "re-export" | "exported-binding" = "import",
      site: ts.Node = node,
    ) => {
      if (!ts.isStringLiteral(node)) {
        report(node.parent, "dynamic-import.*");
        return;
      }
      const resolved = input.imports && Object.hasOwn(input.imports, node.text)
        ? input.imports[node.text]
        : undefined;
      const target = moduleIdentity(resolved ?? node.text),
        owners = Object.hasOwn(rules.modules, target)
          ? rules.modules[target]
          : undefined;
      if (
        ((kind === "re-export" || kind === "exported-binding") &&
          rules.privateExports?.includes(target)) ||
        (kind !== "exported-binding" && owners && !owners.includes(input.file))
      ) {
        report(site, `module:${target}`);
      } else if (
        kind !== "exported-binding" && !resolved &&
        (kind === "dynamic" || !target.startsWith("node:"))
      ) {
        report(node.parent, "unresolved-import");
      }
    };
    const exportedBinding = (site: ts.Node, symbol: ts.Symbol | undefined) => {
      for (const declaration of symbol?.declarations ?? []) {
        for (
          let node: ts.Node | undefined = declaration;
          node;
          node = node.parent
        ) {
          if (ts.isImportDeclaration(node)) {
            if (!isErasedPosition(declaration)) {
              dependency(node.moduleSpecifier, "exported-binding", site);
            }
            break;
          }
        }
      }
    };
    // Enumerate the whole AST first, with no pruning or rule-dependent returns.
    // Classification below can exempt an occurrence, never conceal descendants.
    const nodes: ts.Node[] = [];
    const collect = (node: ts.Node) => {
      nodes.push(node);
      ts.forEachChild(node, collect);
    };
    collect(ast);
    for (const node of nodes) {
      const root = ts.isIdentifier(node) &&
        Object.hasOwn(rules.roots, node.text);
      const importCall = ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (
        !root && !importCall && !ts.isImportDeclaration(node) &&
        !ts.isExportDeclaration(node) && !ts.isExportAssignment(node) &&
        !ts.isImportEqualsDeclaration(node)
      ) continue;
      if (isErasedPosition(node)) continue;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause, bindings = clause?.namedBindings;
        const erased = clause?.isTypeOnly ||
          (!clause?.name && bindings && ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 && bindings.elements.every((s) =>
              s.isTypeOnly
            ));
        if (!erased) dependency(node.moduleSpecifier);
        continue;
      }
      if (ts.isExportDeclaration(node)) {
        const clause = node.exportClause;
        const erased = node.isTypeOnly ||
          (clause && ts.isNamedExports(clause) && clause.elements.length > 0 &&
            clause.elements.every((s) => s.isTypeOnly));
        if (!erased && node.moduleSpecifier) {
          dependency(node.moduleSpecifier, "re-export");
        } else if (!erased && clause && ts.isNamedExports(clause)) {
          for (const specifier of clause.elements) {
            if (!specifier.isTypeOnly) {
              exportedBinding(
                specifier,
                checker.getExportSpecifierLocalTargetSymbol(specifier),
              );
            }
          }
        }
        if (node.moduleSpecifier || erased) continue;
      }
      if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
        exportedBinding(node, checker.getSymbolAtLocation(node.expression));
      }
      if (ts.isImportEqualsDeclaration(node)) {
        if (
          !node.isTypeOnly &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression
        ) dependency(node.moduleReference.expression);
        continue;
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) dependency(node.arguments[0], "dynamic");
      if (
        ts.isIdentifier(node) && Object.hasOwn(rules.roots, node.text) &&
        isReference(node)
      ) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : ts.isExportSpecifier(node.parent)
          ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        // JS expando writes create synthetic Identifier declarations, not lexical shadows.
        const lexical = symbol &&
          (symbol.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) &&
          symbol.declarations?.some((d) =>
            LEXICAL_DECLARATIONS.has(d.kind) &&
            !d.getSourceFile().isDeclarationFile &&
            !ts.isTypeOnlyImportOrExportDeclaration(d) &&
            !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient)
          );
        if (!lexical) {
          const parent = node.parent, rule = rules.roots[node.text];
          if (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node && !parent.questionDotToken
          ) {
            const member = parent.name.text,
              owners = rule.ownedMembers?.[member];
            if (
              owners
                ? !owners.includes(input.file)
                : !rule.members.includes(member)
            ) report(parent, `${node.text}.${member}`);
          } else if (
            !(
              ts.isNewExpression(parent) && parent.expression === node &&
                rule.ownedConstructors?.includes(input.file) ||
              ts.isBinaryExpression(parent) && parent.right === node &&
                parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
                rule.ownedInstanceChecks?.includes(input.file)
            )
          ) {
            report(
              ts.isElementAccessExpression(parent) && parent.expression === node
                ? parent
                : node,
              `${node.text}.*`,
            );
          }
        }
      }
    }
  }
  return sites.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line ||
    a.source.localeCompare(b.source)
  );
}

/** Consume exact occurrences: copying a baseline site cannot spend it twice. */
export function inventoryErrors(
  sites: OwnershipSite[],
  inventory: LegacySite[],
  files: Set<string>,
): string[] {
  const remaining = [...sites], errors: string[] = [];
  for (const entry of inventory) {
    if (!entry.family || !entry.replacement || !entry.consumers.length) {
      errors.push(`unclassified inventory: ${entry.file}`);
    }
    for (const consumer of entry.consumers) {
      if (!files.has(consumer)) {
        errors.push(`missing consumer: ${consumer} (${entry.file})`);
      }
    }
    const index = remaining.findIndex((site) =>
      site.file === entry.file && site.capability === entry.capability &&
      site.source === entry.source && site.context === entry.context
    );
    if (index < 0) {
      errors.push(
        `stale inventory: ${entry.file}:${entry.line}: ${entry.source}`,
      );
    } else remaining.splice(index, 1);
  }
  return errors.concat(
    remaining.map((site) =>
      `unowned capability: ${site.file}:${site.line}: ${site.capability}: ${site.source}`
    ),
  );
}
export function familyInventoryErrors(
  inventory: LegacySite[],
  families: Record<string, OwnershipFamily>,
  files: Set<string>,
  nativeCases: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const entry of inventory) {
    if (!families[entry.family]) {
      errors.push(`absent protected family: ${entry.family}`);
    }
    if (
      entry.allowed &&
      (!families[entry.family]?.allowed ||
        entry.reason !== families[entry.family]?.reason)
    ) errors.push(`unapproved allowed site: ${entry.file}`);
  }
  for (
    const [family, { consumers, replacement, closed, allowed, reason }]
      of Object.entries(families)
  ) {
    if (!consumers.length || !replacement) {
      errors.push(`absent consumer family: ${family}`);
    }
    if (
      closed &&
      inventory.some((entry) => entry.family === family && !entry.allowed)
    ) errors.push(`residual inventory declared closed: ${family}`);
    if (allowed && !reason) {
      errors.push(`allowed family lacks rationale: ${family}`);
    }
    for (const consumer of consumers) {
      if (!files.has(consumer)) {
        errors.push(`lost ${family} consumer: ${consumer}`);
      }
      if (consumer.endsWith(".mjs") && !nativeCases.has(consumer)) {
        errors.push(`unregistered ${family} consumer: ${consumer}`);
      }
    }
  }
  return errors;
}

export const OWNERSHIP_SOURCE_ROOTS = [
  "server",
  "tests",
  "client/tests/e2e",
] as const;
const SOURCE_FILE = /\.(?:[cm]?[tj]s|[tj]sx)$/;
export interface OwnershipCoverage {
  root: string;
  files: readonly string[];
  roots: Readonly<Record<string, number>>;
}
const COVERAGE = new WeakMap<SourceModule[], OwnershipCoverage>();
export function assertModuleCoverage(
  expected: readonly string[],
  parsed: readonly string[],
): void {
  if (!expected.length || !parsed.length) {
    throw new Error("ownership coverage: empty module set");
  }
  for (
    const [label, files] of [["expected", expected], [
      "parsed",
      parsed,
    ]] as const
  ) {
    if (new Set(files).size !== files.length) {
      throw new Error(`ownership coverage: duplicate ${label} module`);
    }
    for (const file of files) {
      if (
        path.isAbsolute(file) || path.normalize(file) !== file ||
        file === ".." || file.startsWith("../")
      ) {
        throw new Error(
          `ownership coverage: noncanonical ${label} module ${file}`,
        );
      }
    }
  }
  const wanted = new Set(expected), actual = new Set(parsed);
  const missing = expected.filter((file) => !actual.has(file)),
    extra = parsed.filter((file) => !wanted.has(file));
  if (missing.length || extra.length) {
    throw new Error(
      `ownership coverage mismatch: missing=${JSON.stringify(missing)} extra=${
        JSON.stringify(extra)
      }`,
    );
  }
}
export function ownershipCoverage(sources: SourceModule[]): OwnershipCoverage {
  const coverage = COVERAGE.get(sources);
  if (!coverage) {
    throw new Error("ownership coverage: no source-owner manifest");
  }
  assertModuleCoverage(coverage.files, sources.map((source) => source.file));
  return coverage;
}

/** Roots are enumerated independently of import reachability and spelling. */
export class OwnershipSourceOwner {
  constructor(private readonly directory: string) {}
  async analyze(input: string, rules = PROCESS_OWNERSHIP) {
    const sources = await this.sources(input),
      sites = analyzeOwnership(sources, rules);
    return { sources, sites, coverage: ownershipCoverage(sources) };
  }
  async sources(input: string): Promise<SourceModule[]> {
    if (!input.trim()) throw new Error("ownership coverage: empty root");
    const root = await Deno.realPath(input);
    if (root !== await Deno.realPath(this.directory)) {
      throw new Error(`ownership coverage: root mismatch ${root}`);
    }
    const files: string[] = [], roots: Record<string, number> = {};
    const visit = async (directory: string) => {
      for await (const entry of Deno.readDir(path.join(root, directory))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory) await visit(file);
        else if (entry.isFile && SOURCE_FILE.test(file)) files.push(file);
      }
    };
    for (const directory of OWNERSHIP_SOURCE_ROOTS) {
      const before = files.length;
      try {
        await visit(directory);
      } catch (cause) {
        throw new Error(
          `ownership coverage: missing source root ${directory}`,
          { cause },
        );
      }
      roots[directory] = files.length - before;
      if (!roots[directory]) {
        throw new Error(`ownership coverage: empty source root ${directory}`);
      }
    }
    const entry = await Deno.makeTempFile({
      prefix: "ownership-graph-",
      suffix: ".ts",
    });
    try {
      await Deno.writeTextFile(
        entry,
        files.map((file) =>
          `import ${
            JSON.stringify(path.toFileUrl(path.join(root, file)).href)
          };`
        ).join("\n"),
      );
      const output = await command(DENO, {
        args: ["info", "--json", `--config=${root}/deno.json`, entry],
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!output.success) {
        throw new Error(
          `ownership deno info: ${new TextDecoder().decode(output.stderr)}`,
        );
      }
      const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as {
        modules: {
          specifier: string;
          error?: string;
          dependencies?: {
            specifier: string;
            code?: { specifier: string };
            type?: { specifier: string };
          }[];
        }[];
      };
      for (const module of graph.modules) {
        if (module.error) {
          throw new Error(
            `ownership graph: ${module.specifier}: ${module.error}`,
          );
        }
      }
      const local = (specifier: string) => {
        if (!specifier.startsWith("file:")) return specifier;
        const relative = path.relative(
          root,
          path.normalize(path.fromFileUrl(specifier)),
        );
        return !path.isAbsolute(relative) && relative !== ".." &&
            !relative.startsWith("../")
          ? relative
          : specifier;
      };
      const parsedFiles = new Set(files);
      for (const module of graph.modules) {
        const file = local(module.specifier);
        if (
          file !== module.specifier && SOURCE_FILE.test(file) &&
          !file.startsWith("node_modules/")
        ) parsedFiles.add(file);
      }
      const expected = [...parsedFiles].sort(),
        graphModules = new Map<string, typeof graph.modules[number]>();
      for (const module of graph.modules) {
        const file = local(module.specifier);
        if (!parsedFiles.has(file)) continue;
        if (graphModules.has(file)) {
          throw new Error(`ownership coverage: duplicate graph module ${file}`);
        }
        graphModules.set(file, module);
      }
      assertModuleCoverage(expected, [...graphModules.keys()]);
      const sources = await Promise.all(expected.map(async (file) => ({
        file,
        text: await Deno.readTextFile(path.join(root, file)),
        imports: Object.fromEntries(
          (graphModules.get(file)!.dependencies ?? []).map(
            (edge) => [
              edge.specifier,
              local(
                edge.code?.specifier ?? edge.type?.specifier ?? edge.specifier,
              ),
            ],
          ),
        ),
      })));
      COVERAGE.set(
        sources,
        Object.freeze({
          root,
          files: Object.freeze(expected),
          roots: Object.freeze(roots),
        }),
      );
      ownershipCoverage(sources);
      return sources;
    } finally {
      await Deno.remove(entry);
    }
  }
}
const repositoryOwner = new OwnershipSourceOwner(
  path.fromFileUrl(new URL("../../", import.meta.url)),
);
export const repositorySources = (root: string): Promise<SourceModule[]> =>
  repositoryOwner.sources(root);
export const repositoryOwnership = (root: string, rules = PROCESS_OWNERSHIP) =>
  repositoryOwner.analyze(root, rules);
