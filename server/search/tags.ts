// SPDX-License-Identifier: LGPL-3.0-only

/** Tag extraction, ported from file_system.py. */

const CODEBLOCK_RE = /`{1,3}.*?`{1,3}/gs;
const TAGS_RE = /(?<=^#|(?<=\s#))[a-zA-Z0-9_-]+(?=\s|$)/g;

export function extractTags(
  content: string,
): { contentExTags: string; tagSet: Set<string> } {
  const contentExBlock = content.replace(CODEBLOCK_RE, "");
  const tagSet = new Set(
    [...contentExBlock.matchAll(TAGS_RE)].map((m) => m[0].toLowerCase()),
  );
  return { contentExTags: content, tagSet };
}
