// SPDX-License-Identifier: LGPL-3.0-only
/** Static ownership contract, not a sandbox. The compiler owns syntax, scopes
 * and exports; this file interprets only the declared capability values. */
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
const CREDENTIAL_IMPORTS: Record<string, Record<string, string>> = {
  "@std/encoding/base32": {
    encodeBase32: "credential.raw-base32",
    decodeBase32: "credential.raw-base32",
  },
  otplib: { totp: "credential.raw-verifier" },
  "otplib/core.js": { hotpCreateHmacKey: "credential.raw-verifier" },
  "server/auth/credentials.ts": {
    totpSecretFromRawKey: "credential.raw-secret",
    matchingTotpStep: "credential.raw-verifier",
    checkTotpCode: "credential.raw-verifier",
  },
};

/** Independently checked before any module can enter the analyzed set. An EOF
 * wrapper alone is not evidence that the statement list consumed the source. */
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

type Value = { path: string } | { text: string } | { module: string } | {
  fields: Map<string, Value>;
} | undefined;
const cap = (name: string): Value => ({ path: name });
const namespace = (name: string) =>
  ["Deno", "globalThis", "module", "process", "child_process"].includes(name);
const protectedPath = (name: string): string | undefined => {
  if (name.startsWith("credential.")) return name;
  if (name === "TextEncoder" || name.startsWith("TextEncoder.")) {
    return "credential.raw-utf8";
  }
  if (
    [
      "Deno.Command",
      "Deno.run",
      "Deno.*",
      "globalThis.*",
      "dynamic-import.*",
      "module.createRequire",
      "module.*",
      "process.*",
      "process.getBuiltinModule",
      "require",
    ].includes(name) || name.startsWith("child_process")
  ) return name;
};

export function analyzeOwnership(sources: SourceModule[]): OwnershipSite[] {
  const expected = COVERAGE.get(sources)?.files ?? sources.map((s) => s.file);
  assertModuleCoverage(expected, sources.map((s) => s.file));
  const inputs = new Map(sources.map((s) => [s.file, s]));
  const filename = (file: string) => `/repository/${file}`;
  const identity = (file: string) => file.slice("/repository/".length);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    allowJs: true,
    noLib: true,
    noEmit: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (file, language) => {
      const input = inputs.get(identity(file));
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
    fileExists: (file) => inputs.has(identity(file)),
    readFile: (file) => inputs.get(identity(file))?.text,
    resolveModuleNames: (names, file) =>
      names.map((name) => {
        const target = inputs.get(identity(file))?.imports?.[name];
        return target && inputs.has(target)
          ? { resolvedFileName: filename(target) }
          : undefined;
      }),
  };
  const program = ts.createProgram(
    sources.map((s) => filename(s.file)),
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const modules = new Map(
    program.getSourceFiles().map((ast) => [identity(ast.fileName), ast]),
  );
  assertModuleCoverage(expected, [...modules.keys()]);
  for (const [file, ast] of modules) {
    assertOwnershipParse(
      ast,
      inputs.get(file)!.text,
      program.getSyntacticDiagnostics(ast),
    );
  }
  const assignments = new Map<ts.Symbol, ts.Expression[]>();
  const collectAssignments = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) {
        assignments.set(symbol, [
          ...(assignments.get(symbol) ?? []),
          node.right,
        ]);
      }
    }
    ts.forEachChild(node, collectAssignments);
  };
  for (const ast of modules.values()) collectAssignments(ast);
  const imported = (node: ts.Node, specifier: string): Value => {
    if (CREDENTIAL_IMPORTS[specifier]) return { module: specifier };
    if (
      ["child_process", "module", "process"].includes(
        specifier.replace(/^node:/, ""),
      )
    ) return cap(specifier.replace(/^node:/, ""));
    const file = inputs.get(identity(node.getSourceFile().fileName))?.imports
      ?.[specifier] ??
      (specifier.startsWith("file:///repository/")
        ? decodeURI(specifier.slice(19))
        : specifier);
    return CREDENTIAL_IMPORTS[file] || modules.has(file)
      ? { module: file }
      : undefined;
  };
  const resolving = new Set<ts.Node | ts.Symbol | string>();
  const guarded = (
    key: ts.Node | ts.Symbol | string,
    read: () => Value,
  ): Value => {
    if (resolving.has(key)) return;
    resolving.add(key);
    try {
      return read();
    } finally {
      resolving.delete(key);
    }
  };
  const symbolValue = (symbol: ts.Symbol | undefined): Value =>
    symbol && guarded(symbol, () => {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) return;
      const declared =
        CREDENTIAL_IMPORTS[identity(declaration.getSourceFile().fileName)]
          ?.[symbol.name];
      if (declared) return cap(declared);
      if (
        ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration)
      ) {
        let ancestor: ts.Node = declaration;
        while (!ts.isImportDeclaration(ancestor)) ancestor = ancestor.parent;
        if (
          ancestor.importClause?.isTypeOnly ||
          (ts.isImportSpecifier(declaration) && declaration.isTypeOnly)
        ) return;
        const value = imported(
          ancestor,
          (ancestor.moduleSpecifier as ts.StringLiteral).text,
        );
        if (ts.isNamespaceImport(declaration)) return value;
        const name = ts.isImportSpecifier(declaration)
          ? (declaration.propertyName ?? declaration.name).text
          : "default";
        return name === "default" && value && "path" in value
          ? value
          : member(value, name);
      }
      if (
        ts.isImportEqualsDeclaration(declaration) &&
        ts.isExternalModuleReference(declaration.moduleReference)
      ) {
        return imported(
          declaration,
          (declaration.moduleReference.expression as ts.StringLiteral).text,
        );
      }
      if (symbol.flags & ts.SymbolFlags.Alias) {
        return symbolValue(checker.getAliasedSymbol(symbol));
      }
      if (ts.isBindingElement(declaration)) return evaluate(declaration);
      if (ts.isExportAssignment(declaration)) {
        return evaluate(declaration.expression);
      }
      if (
        ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) ||
        ts.isPropertyAssignment(declaration)
      ) {
        const values = [
          declaration.initializer,
          ...(assignments.get(symbol) ?? []),
        ].map(evaluate);
        const value = values.find((value) => inside(value)) ??
          values.find(Boolean);
        return value && "text" in value &&
            ts.isVariableDeclaration(declaration) &&
            !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)
          ? undefined
          : value;
      }
      if (ts.isShorthandPropertyAssignment(declaration)) {
        return symbolValue(
          checker.getShorthandAssignmentValueSymbol(declaration),
        );
      }
    });
  const member = (value: Value, name?: string): Value => {
    if (!value) return;
    if ("path" in value) {
      return cap(
        value.path === "globalThis" &&
          ["Deno", "process", "require", "TextEncoder"].includes(name ?? "")
          ? name!
          : `${value.path}.${name ?? "*"}`,
      );
    }
    if ("fields" in value) {
      return name === undefined && inside(value)
        ? cap("dynamic-import.*")
        : value.fields.get(name ?? "");
    }
    if ("module" in value) {
      if (name === undefined) {
        return cap(
          CREDENTIAL_IMPORTS[value.module]
            ? "credential.dynamic"
            : "dynamic-import.*",
        );
      }
      const declared = CREDENTIAL_IMPORTS[value.module]?.[name];
      if (declared) return cap(declared);
      const ast = modules.get(value.module),
        symbol = ast && checker.getSymbolAtLocation(ast);
      return symbolValue(
        symbol &&
          checker.getExportsOfModule(symbol).find((s) => s.name === name),
      );
    }
  };
  const text = (node: ts.Node | undefined): string | undefined => {
    const value = evaluate(node);
    return value && "text" in value ? value.text : undefined;
  };
  const property = (node: ts.Node): string | undefined =>
    ts.isIdentifier(node) || ts.isStringLiteralLike(node)
      ? node.text
      : ts.isComputedPropertyName(node)
      ? text(node.expression)
      : text(node);
  const evaluate = (node: ts.Node | undefined): Value =>
    node && guarded(node, () => {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        // JS expando writes can give a runtime global a synthetic Identifier
        // declaration. That is not a lexical shadow of the runtime namespace.
        const lexical = symbol?.declarations?.some((d) => !ts.isIdentifier(d));
        return lexical ? symbolValue(symbol) : [
            "Deno",
            "globalThis",
            "window",
            "self",
            "process",
            "require",
            "TextEncoder",
          ].includes(node.text)
          ? cap(
            ["window", "self"].includes(node.text) ? "globalThis" : node.text,
          )
          : undefined;
      }
      if (ts.isStringLiteralLike(node)) return { text: node.text };
      if (ts.isTemplateExpression(node)) {
        let result = node.head.text;
        for (const part of node.templateSpans) {
          const value = text(part.expression);
          if (value === undefined) return;
          result += value + part.literal.text;
        }
        return { text: result };
      }
      if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          const left = text(node.left), right = text(node.right);
          return left !== undefined && right !== undefined
            ? { text: left + right }
            : undefined;
        }
        if (
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.CommaToken
        ) return evaluate(node.right);
      }
      if (ts.isPropertyAccessExpression(node)) {
        return member(evaluate(node.expression), node.name.text);
      }
      if (ts.isElementAccessExpression(node)) {
        return member(evaluate(node.expression), text(node.argumentExpression));
      }
      if (ts.isObjectLiteralExpression(node)) {
        return {
          fields: new Map(
            node.properties.flatMap((p) =>
              ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
                ? [[
                  property(p.name) ?? "",
                  ts.isPropertyAssignment(p)
                    ? evaluate(p.initializer)
                    : symbolValue(checker.getShorthandAssignmentValueSymbol(p)),
                ] as [string, Value]]
                : []
            ),
          ),
        };
      }
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        return evaluate(node.initializer);
      }
      if (ts.isBindingElement(node)) {
        return member(
          evaluate(node.parent.parent),
          ts.isArrayBindingPattern(node.parent)
            ? String(node.parent.elements.indexOf(node))
            : property(node.propertyName ?? node.name),
        ) ?? evaluate(node.initializer);
      }
      if (
        ts.isAwaitExpression(node) || ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
      ) return evaluate(node.expression);
      if (
        ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        return {
          fields: new Map([["url", {
            text: `file:///repository/${
              identity(node.getSourceFile().fileName)
            }`,
          }]]),
        };
      }
      if (
        ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "URL" &&
        !checker.getSymbolAtLocation(node.expression)
      ) {
        const relative = text(node.arguments?.[0]),
          base = text(node.arguments?.[1]);
        if (relative !== undefined) {
          try {
            return {
              fields: new Map([["href", {
                text: new URL(relative, base).href,
              }]]),
            };
          } catch { /* Not a statically valid URL. */ }
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const specifier = text(node.arguments[0]);
        return specifier === undefined
          ? cap("dynamic-import.*")
          : imported(node, specifier);
      }
    });
  const inspecting = new Set<string>();
  const inside = (value: Value): string | undefined => {
    if (!value) return;
    if ("path" in value) {
      return protectedPath(value.path) ??
        (namespace(value.path) ? `${value.path}.*` : undefined);
    }
    if ("fields" in value) {
      return [...value.fields.values()].map(inside).find(Boolean);
    }
    if ("module" in value && !inspecting.has(value.module)) {
      if (CREDENTIAL_IMPORTS[value.module]) {
        return Object.values(CREDENTIAL_IMPORTS[value.module])[0];
      }
      inspecting.add(value.module);
      try {
        const ast = modules.get(value.module),
          symbol = ast && checker.getSymbolAtLocation(ast);
        return symbol &&
          checker.getExportsOfModule(symbol).map((s) =>
            inside(member(value, s.name))
          ).find(Boolean);
      } finally {
        inspecting.delete(value.module);
      }
    }
  };
  const sites: OwnershipSite[] = [], seen = new Set<string>();
  const report = (node: ts.Node, value: Value, escape = false) => {
    const name = value && "path" in value && !escape
      ? protectedPath(value.path)
      : inside(value);
    if (!name) return;
    const ast = node.getSourceFile(),
      start = node.getStart(ast),
      file = identity(ast.fileName),
      line = ast.getLineAndCharacterOfPosition(start).line + 1;
    const key = `${file}:${start}:${node.end}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({
      file,
      capability: name,
      line,
      source: ast.text.slice(start, node.end),
      context: ast.text.split("\n")[line - 1].trim(),
    });
  };
  const visit = (node: ts.Node) => {
    // Types are parsed and validated, but are not runtime acquisitions.
    if (ts.isTypeNode(node)) return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly) {
        const value = imported(
          node,
          (node.moduleSpecifier as ts.StringLiteral).text,
        );
        const bindings = clause?.namedBindings;
        const onlyTypes = bindings && ts.isNamedImports(bindings) &&
          bindings.elements.length && bindings.elements.every((s) =>
            s.isTypeOnly
          );
        if (
          !onlyTypes && value && "path" in value &&
          value.path === "child_process"
        ) report(node.moduleSpecifier, value);
        if (clause?.name) report(clause.name, evaluate(clause.name));
        if (bindings && ts.isNamespaceImport(bindings)) {
          report(bindings.name, evaluate(bindings.name));
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const specifier of bindings.elements) {
            if (!specifier.isTypeOnly) {
              report(specifier.name, evaluate(specifier.name));
            }
          }
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (
        !node.isTypeOnly && node.moduleSpecifier &&
        (!node.exportClause || !ts.isNamedExports(node.exportClause) ||
          node.exportClause.elements.some((s) => !s.isTypeOnly))
      ) {
        report(
          node.moduleSpecifier,
          imported(node, (node.moduleSpecifier as ts.StringLiteral).text),
        );
      }
      return;
    }
    if (ts.isExternalModuleReference(node) && node.expression) {
      report(
        node.expression,
        imported(node, (node.expression as ts.StringLiteral).text),
      );
    }
    if (
      ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const parent = node.parent, value = evaluate(node);
      const namePosition = ("name" in parent && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node);
      if (!ts.isIdentifier(node) && !namePosition) {
        report(node, value);
      }
      if (value && "path" in value && namespace(value.path) && !namePosition) {
        const alias = ((ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
          parent.expression === node) ||
          ts.isVariableDeclaration(parent) || ts.isAsExpression(parent) ||
          ts.isTypeAssertionExpression(parent) ||
          ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent) ||
          ts.isParenthesizedExpression(parent) ||
          (ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(parent.left));
        if (
          !alias && !ts.isPropertyAssignment(parent) &&
          !ts.isShorthandPropertyAssignment(parent)
        ) report(node, value, true);
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      report(node, evaluate(node.name));
    }
    if (ts.isReturnStatement(node) && node.expression) {
      report(node.expression, evaluate(node.expression), true);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) report(node, evaluate(node));
      else report(node.expression, evaluate(node.expression));
      for (const argument of node.arguments ?? []) {
        report(argument, evaluate(argument), true);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      !ts.isIdentifier(node.left)
    ) {
      const value = evaluate(node.right);
      if (!(value && "path" in value && protectedPath(value.path))) {
        report(node.right, value, true);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const ast of modules.values()) visit(ast);
  return sites.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line ||
    a.source.localeCompare(b.source)
  );
}

export const CHILD_OWNER = "tests/helpers/process.ts";
export const SECRET_OWNER = "server/auth/credentials.ts";
export const protectedSource = (file: string, capability = "") =>
  capability.startsWith("credential.")
    ? file.startsWith("server/auth/") ||
      file === "server/api/endpoints/_/api/setup/post.ts"
    : OWNERSHIP_SOURCE_ROOTS.filter((root) => root !== "server").some((root) =>
      file.startsWith(root + "/")
    );

/** Consume exact occurrences: a duplicate cannot spend one allowance twice. */
export function inventoryErrors(
  sites: OwnershipSite[],
  inventory: LegacySite[],
  files: Set<string>,
): string[] {
  const remaining = sites.filter((site) =>
    protectedSource(site.file, site.capability) &&
    site.file !==
      (site.capability.startsWith("credential.") ? SECRET_OWNER : CHILD_OWNER)
  );
  const errors: string[] = [];
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
const SOURCE_FILE = /\.(ts|js|mjs)$/;
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

/** One owner declares and enumerates roots independently of import reachability. */
export class OwnershipSourceOwner {
  constructor(private readonly directory: string) {}
  async analyze(input: string) {
    const sources = await this.sources(input),
      sites = analyzeOwnership(sources);
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
export const repositoryOwnership = (root: string) =>
  repositoryOwner.analyze(root);
