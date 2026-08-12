import { params, searchSortOptions } from "../../constants.js";
import { resolveNoteTitle } from "../../noteIndex.js";
import { notePath } from "../../notePath.js";

import router from "../../router.js";
import { slugifyHeading } from "./baseOptions.js";

/*
 * Sourced from toast-ui. Their autolink options are
 * either override their built in functionality or
 * use their built in functionality. We'd like to have
 * both so this is the source of their parsers.
 */
const DOMAIN = "(?:[w-]+.)*[A-Za-z0-9-]+.[A-Za-z0-9-]+";
const PATH = "[^<\\s]*[^<?!.,:*_?~\\s]";
const EMAIL = "[\\w.+-]+@(?:[\\w-]+\\.)+[\\w-]+";
function trimUnmatchedTrailingParens(source) {
  const trailingParen = /\)+$/.exec(source);
  if (trailingParen) {
    let count = 0;
    for (const ch of source) {
      if (ch === "(") {
        if (count < 0) {
          count = 1;
        } else {
          count += 1;
        }
      } else if (ch === ")") {
        count -= 1;
      }
    }

    if (count < 0) {
      const trimCount = Math.min(-count, trailingParen[0].length);
      return source.substring(0, source.length - trimCount);
    }
  }
  return source;
}

function trimTrailingEntity(source) {
  return source.replace(/&[A-Za-z0-9]+;$/, "");
}
export function parseEmailLink(source) {
  const reEmailLink = new RegExp(EMAIL, "g");
  const result = [];
  let m;
  while ((m = reEmailLink.exec(source))) {
    const text = m[0];
    if (!/[_-]+$/.test(text)) {
      result.push({
        text,
        range: [m.index, m.index + text.length - 1],
        url: `mailto:${text}`,
      });
    }
  }

  return result;
}

export function parseUrlLink(source) {
  const reWwwAutolink = new RegExp(`(www|https?://)\.${DOMAIN}${PATH}`, "g");
  const result = [];
  let m;

  while ((m = reWwwAutolink.exec(source))) {
    const text = trimTrailingEntity(trimUnmatchedTrailingParens(m[0]));
    const scheme = m[1] === "www" ? "http://" : "";
    result.push({
      text,
      range: [m.index, m.index + text.length - 1],
      url: `${scheme}${text}`,
    });
  }

  return result;
}
// end of raw toast-ui source

function parseWikiLink(source) {
  const matched = source.matchAll(/\[\[\s*(\S(?:[^\[\]]*?\S)?)\s*\]\]/g);
  if (!matched) {
    return null;
  }
  return Array.from(matched).flatMap((match) => {
    // Skip embeds (![[...]]); those are handled by preprocessing.
    if (match.index > 0 && source[match.index - 1] === "!") {
      return [];
    }
    const inner = match[1];
    const pipeIndex = inner.indexOf("|");
    const targetPart = (
      pipeIndex === -1 ? inner : inner.slice(0, pipeIndex)
    ).trim();
    const alias =
      pipeIndex === -1 ? null : inner.slice(pipeIndex + 1).trim();
    const hashIndex = targetPart.indexOf("#");
    const target =
      hashIndex === -1 ? targetPart : targetPart.slice(0, hashIndex);
    const anchor =
      hashIndex === -1 ? null : targetPart.slice(hashIndex + 1);
    let path = notePath(resolveNoteTitle(target));
    if (anchor) {
      path += `#${slugifyHeading(anchor)}`;
    }
    return [
      {
        text: alias || targetPart,
        range: [match.index, match.index + match[0].length - 1],
        url: `${router.resolve(path).href}`,
      },
    ];
  });
}

function parseTagLink(source) {
  const matched = source.matchAll(/(?:^|\s)(#[a-zA-Z0-9_-]+)(?=\s|$)/g);
  if (matched) {
    return Array.from(matched).map((match) => {
      const text = match[1];
      return {
        text,
        range: [
          match.index + match[0].indexOf(text),
          match.index + match[0].indexOf(text) + text.length - 1,
        ],
        url: `${
          router.resolve({
            name: "search",
            query: {
              [params.searchTerm]: text,
              [params.sortBy]: searchSortOptions.title,
            },
          }).href
        }`,
      };
    });
  }

  return null;
}

function extendedAutolinks(source) {
  return [
    ...parseUrlLink(source),
    ...parseEmailLink(source),
    ...parseWikiLink(source),
    ...parseTagLink(source),
  ].sort((a, b) => a.range[0] - b.range[0]);
}

export default extendedAutolinks;
