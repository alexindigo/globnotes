// SPDX-License-Identifier: LGPL-3.0-only

// Autolinks — parity with the old client's ToastUI extendedAutolinks:
//   [[target]], [[target|alias]], [[target#heading]] → note links
//   #tag → search link
// Title resolution is Obsidian-style: exact path first, then vault-wide
// basename match, unresolved used as written.

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

function resolveTitle(target, titles) {
  const trimmed = target.trim();
  if (titles.includes(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const matches = titles.filter(
    (t) => t.split("/").pop().toLowerCase() === lower,
  );
  return matches.length > 0 ? matches.sort()[0] : trimmed;
}

export function getSelectors() {
  return [{ node: "text", params: { hasAny: ["[[", "#"] } }];
}

export async function parseNode(node, ctx) {
  let out = node.content;
  let changed = false;

  if (out.includes("[[")) {
    const [titles, prefix] = await Promise.all([
      ctx.listTitles(),
      ctx.pathPrefix(),
    ]);
    out = out.replace(
      /\[\[\s*(\S(?:[^\[\]]*?\S)?)\s*\]\]/g,
      (m, inner, offset, full) => {
        // Skip embeds (![[...]]); the embeds plugin owns those.
        if (offset > 0 && full[offset - 1] === "!") return m;
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
        let url = prefix + notePath(resolveTitle(target, titles));
        if (anchor) url += "#" + slugifyHeading(anchor);
        changed = true;
        return `[${alias || targetPart}](${url})`;
      },
    );
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
