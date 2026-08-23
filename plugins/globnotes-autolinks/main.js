// SPDX-License-Identifier: LGPL-3.0-only

// Autolinks — parity with the old client's ToastUI extendedAutolinks:
//   [[target]], [[target|alias]], [[target#heading]] → note links
//   #tag → search link
// Title resolution is Obsidian-style and server-side (ctx.resolveTitle):
// exact path → vault-wide basename → front-matter alias; unresolved used
// as written.

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-\s]*/g, "")
    .trim()
    .replace(/\s/g, "-");
}

function notePath(title) {
  return "/" + title.split("/").map(encodeURIComponent).join("/");
}

export function getSelectors() {
  return [{ node: "text", params: { hasAny: ["[[", "#"] } }];
}

const WIKILINK_RE = /\[\[\s*(\S(?:[^\[\]]*?\S)?)\s*\]\]/g;

export async function parseNode(node, ctx) {
  let out = node.content;
  let changed = false;

  if (out.includes("[[")) {
    const prefix = await ctx.pathPrefix();
    // Collect matches first (replace callbacks can't await), resolve each
    // target, then splice the replacements in.
    const matches = [...out.matchAll(WIKILINK_RE)].filter(
      (m) => !(m.index > 0 && out[m.index - 1] === "!"),
    );
    const replacements = new Map();
    for (const m of matches) {
      const inner = m[1];
      const pipeIndex = inner.indexOf("|");
      const targetPart =
        (pipeIndex === -1 ? inner : inner.slice(0, pipeIndex)).trim();
      const alias =
        pipeIndex === -1 ? null : inner.slice(pipeIndex + 1).trim();
      const hashIndex = targetPart.indexOf("#");
      const target =
        hashIndex === -1 ? targetPart : targetPart.slice(0, hashIndex);
      const anchor =
        hashIndex === -1 ? null : targetPart.slice(hashIndex + 1);
      let url = prefix + notePath(await ctx.resolveTitle(target));
      if (anchor) url += "#" + slugifyHeading(anchor);
      replacements.set(m[0], `[${alias || targetPart}](${url})`);
    }
    if (replacements.size > 0) {
      out = out.replace(WIKILINK_RE, (m) => replacements.get(m) ?? m);
      changed = true;
    }
  }

  if (/(?:^|\s)#[a-zA-Z0-9_-]+(?=\s|$)/.test(out)) {
    const prefix = await ctx.pathPrefix();
    out = out.replace(
      /(^|\s)(#[a-zA-Z0-9_-]+)(?=\s|$)/g,
      (m, pre, tag) => {
        changed = true;
        return `${pre}[${tag}](${prefix}/_/search?term=${
          encodeURIComponent(tag)
        }&sortBy=title)`;
      },
    );
  }

  return changed ? { node: { content: out } } : null;
}

export function onSync() {}
