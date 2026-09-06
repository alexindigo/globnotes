// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Frontmatter YAML subset shared by the server renderer and the client
 * WYSIWYG editor. Deliberately NOT a full YAML implementation: it covers
 * what note frontmatter uses — plain/quoted scalars, string lists (flow
 * and block style) — and preserves everything else verbatim. Key order is
 * preserved throughout. Round-trip stability is the contract: values the
 * panel doesn't understand come back out byte-for-byte.
 */

/** A parsed frontmatter value.
 *  - scalar: a single plain/quoted scalar (quotes stripped for editing)
 *  - list:   a string list (flow `[a, b]` or block `- a` style)
 *  - raw:    anything else (nested maps, anchors, comments, multi-line) —
 *            preserved verbatim on serialize (`text` holds everything
 *            after the key's colon, whitespace included) */
export type FrontmatterValue =
  | { kind: "scalar"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "raw"; text: string };

export interface FrontmatterEntry {
  key: string;
  value: FrontmatterValue;
}

/** Internal accumulator while scanning lines. */
interface PendingEntry {
  key: string;
  inline: string;
  body: string[];
}

/** Characters/positions that force double-quoting on serialize. */
function needsQuoting(text: string): boolean {
  if (text === "") return true;
  if (text !== text.trim()) return true;
  if (/[:#]/.test(text)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(text)) return true;
  return false;
}

/** Double-quote a scalar with YAML double-quote escaping. */
function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteIfNeeded(text: string): string {
  return needsQuoting(text) ? quote(text) : text;
}

/** Strip surrounding quotes from a scalar token (both quote styles). */
function unquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** Split a flow sequence body on top-level commas (quote/bracket aware). */
function splitFlow(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoteChar: string | null = null;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoteChar) {
      if (ch === "\\" && quoteChar === '"') {
        current += ch + (body[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === quoteChar) quoteChar = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "" || items.length > 0) items.push(current);
  return items.map(unquote);
}

/** Is this line a frontmatter entry start (`key:` or `key: value`)?
 * Block-sequence lines (`- item`) are never entry starts. */
function entryStart(line: string): { key: string; inline: string } | null {
  if (/^-(\s|$)/.test(line)) return null;
  const m = line.match(/^([^:#\s][^:]*?):(?:[ \t]+(.*))?$/);
  if (!m) return null;
  return { key: m[1], inline: m[2] ?? "" };
}

/** Interpret one entry's scanned lines. */
function interpret(inline: string, body: string[]): FrontmatterValue {
  // Block list: every body line is a (possibly indented) `- item` — the
  // canonical YAML form under a key, as Obsidian writes it.
  if (
    body.length > 0 &&
    body.every((l) => l.trim() === "" || /^\s*-(?:[ \t].*)?$/.test(l))
  ) {
    if (inline === "") {
      return {
        kind: "list",
        items: body
          .filter((l) => l.trim() !== "")
          .map((l) => unquote(l.replace(/^\s*-[ \t]*/, ""))),
      };
    }
  }
  // Flow list: single inline `[...]`.
  const flow = inline.match(/^\[(.*)\]$/s);
  if (flow && body.length === 0) {
    return { kind: "list", items: splitFlow(flow[1]) };
  }
  // Single inline scalar.
  if (body.length === 0) {
    return { kind: "scalar", text: unquote(inline) };
  }
  // Anything else — verbatim, byte-for-byte: everything after the colon
  // on the key line (whitespace included) plus the body lines.
  return {
    kind: "raw",
    text: `${inline}${body.length ? `\n${body.join("\n")}` : ""}`,
  };
}

/** Parse the YAML text inside a `---` fenced frontmatter block. Never
 * throws: anything it cannot interpret lands in a `raw` value verbatim.
 * Lines before the first entry (stray text) carry no key to preserve
 * them under and are dropped. */
export function parseFrontmatter(yaml: string): FrontmatterEntry[] {
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  const pending: PendingEntry[] = [];
  for (const line of lines) {
    const start = entryStart(line);
    if (start) {
      pending.push({ key: start.key, inline: start.inline, body: [] });
    } else if (pending.length > 0) {
      pending[pending.length - 1].body.push(line);
    }
  }
  return pending.map(({ key, inline, body }) => {
    // Trailing blank lines are a cosmetic artifact of the fenced block;
    // they never carry meaning for the entry.
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    return { key, value: interpret(inline, body) };
  });
}

/** Serialize parsed entries back to YAML. Order is preserved; raw values
 * round-trip verbatim. */
export function serializeFrontmatter(entries: FrontmatterEntry[]): string {
  const out: string[] = [];
  for (const { key, value } of entries) {
    if (value.kind === "list") {
      if (value.items.length === 0) {
        out.push(`${key}: []`);
      } else {
        out.push(`${key}:`);
        for (const item of value.items) out.push(`- ${quoteIfNeeded(item)}`);
      }
    } else if (value.kind === "raw") {
      out.push(`${key}:${value.text}`);
    } else {
      out.push(`${key}: ${quoteIfNeeded(value.text)}`);
    }
  }
  return out.join("\n");
}
