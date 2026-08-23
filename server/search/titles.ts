// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Display-title resolution (Obsidian-faithful):
 *   front-matter `title:` → first `# ` heading → filename basename.
 * Front-matter `aliases:` are extracted in the same pass (used by the
 * alias layer for wikilink/display resolution).
 *
 * The front-matter parser is deliberately minimal — `title`/`aliases`
 * keys only, bare or quoted scalars, inline `[a, b]` or block `- a`
 * lists. Anything else in the block is ignored.
 */

export interface TitleInfo {
  displayTitle: string;
  /** The note's first H1 text, if any (used by the H1↔basename sync). */
  h1: string | null;
  /** Front-matter `title:` if present (explicit title wins; H1 sync is
   * off for these notes). */
  fmTitle: string | null;
  aliases: string[];
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse the leading `---` block for `title`/`aliases`. Returns nulls
 * when there is no front matter. */
function parseFrontMatter(content: string): {
  title: string | null;
  aliases: string[] | null;
} {
  const out = {
    title: null as string | null,
    aliases: null as string[] | null,
  };
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return out;
  }
  const lines = content.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return out;

  const block = lines.slice(1, end);
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (key === "title") {
      out.title = unquote(value);
    } else if (key === "aliases") {
      if (value.startsWith("[") && value.endsWith("]")) {
        out.aliases = value
          .slice(1, -1)
          .split(",")
          .map(unquote)
          .filter((s) => s !== "");
      } else if (value === "") {
        // Block list: following indented "- item" lines.
        const items: string[] = [];
        for (let j = i + 1; j < block.length; j++) {
          const li = block[j].match(/^\s+-\s+(.*)$/);
          if (!li) break;
          items.push(unquote(li[1]));
        }
        out.aliases = items.filter((s) => s !== "");
      } else {
        out.aliases = [unquote(value)].filter((s) => s !== "");
      }
    }
  }
  return out;
}

/** The first ATX H1 (`# text`, not `##`) in the body — outside the
 * front-matter block. */
function firstH1(content: string): string | null {
  const body = content.startsWith("---")
    ? content.slice(content.indexOf("\n---", 3) + 4)
    : content;
  for (const line of body.split("\n")) {
    const m = line.match(/^# (.+)$/);
    if (m) return m[1].trim() || null;
  }
  return null;
}
export function resolveTitleInfo(
  basename: string,
  content: string,
): TitleInfo {
  const fm = parseFrontMatter(content);
  const h1 = firstH1(content);
  // Obsidian order: explicit title → aliases[0] → first H1 → basename.
  const displayTitle = fm.title && fm.title !== ""
    ? fm.title
    : fm.aliases && fm.aliases.length > 0
    ? fm.aliases[0]
    : h1 ?? basename;
  return {
    displayTitle,
    h1,
    fmTitle: fm.title && fm.title !== "" ? fm.title : null,
    aliases: fm.aliases ?? [],
  };
}

/** Rewrite the first ATX H1 line to `heading` (rename → H1 sync). */
export function rewriteFirstH1(content: string, heading: string): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^# .+$/.test(lines[i])) {
      lines[i] = `# ${heading}`;
      return lines.join("\n");
    }
  }
  return content;
}

/** Turn H1 text into a filename basename (H1 → rename sync): strip the
 * create-time invalid chars and anything structural, collapse whitespace,
 * trim. Returns null when nothing usable remains. */
export function sanitizeBasename(text: string): string | null {
  const stripped = text
    .replace(/[<>:"\\|?/*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!stripped) return null;
  // Segment limit: 255 bytes.
  const encoded = new TextEncoder().encode(stripped);
  const cut = encoded.length > 255
    ? new TextDecoder().decode(encoded.slice(0, 255)).trimEnd()
    : stripped;
  return cut || null;
}
