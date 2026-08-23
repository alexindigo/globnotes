// SPDX-License-Identifier: LGPL-3.0-only

// ![[image.png]] -> ![](image.png); ![[doc.pdf]] / ![[Note.md]] -> links.
// Note transclusion stays a plain link (parity with the old client's
// obsidianFlavored.js transform).

const IMAGE_EXTENSIONS = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

export function getSelectors() {
  return [{ node: "text", params: { hasAny: ["![["] } }];
}

export function parseNode(node) {
  const out = node.content.replace(
    /!\[\[\s*([^\[\]|]+?)(?:\|([^\[\]]*?))?\s*\]\]/g,
    (_, target, alias) => {
      const trimmedTarget = target.trim();
      const text = (alias || trimmedTarget).trim();
      if (IMAGE_EXTENSIONS.test(trimmedTarget)) {
        return `![${text}](${encodeURI(trimmedTarget)})`;
      }
      return `[${text}](${encodeURI(trimmedTarget)})`;
    },
  );
  if (out === node.content) return null;
  return { node: { content: out } };
}

export function onSync() {}
