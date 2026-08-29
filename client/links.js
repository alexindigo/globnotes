// Client-side link rewriting for renames. The client drives link updates:
// it finds referencing notes (via the references endpoint), computes each
// note's updated content here, and resaves via the update API. The server
// stays a pure file mechanism.

// Wikilinks: [[old]], [[old|alias]], [[old#heading]]. Never ![[embeds]]
// (file references) and never basename-only links (those keep resolving
// via basename matching).
export function rewriteWikilinks(content, oldPath, newPath) {
  const pattern = new RegExp(
    String.raw`(?<!!)\[\[\s*` + escapeRe(oldPath) + String.raw`(\s*(?:[|#][^\]]*)?)\s*\]\]`,
    "g",
  );
  return content.replace(
    pattern,
    (_, suffix) => "[[" + newPath + (suffix || "") + "]]",
  );
}

// Markdown links: [t](/abs/old.md) and [t](../rel/old.md), resolved against
// the referencing note's own folder.
export function rewriteMarkdownLinks(
  content,
  oldPath,
  newPath,
  referencingPath,
) {
  const oldFile = oldPath + ".md";
  const newFile = newPath + ".md";
  const noteDir = dirOf(referencingPath);
  const pattern = /(\[[^\]]*\]\()([^)\s]+)(\))/g;
  return content.replace(pattern, (match, prefix, url, suffix) => {
    if (/^(https?:\/\/|\/\/|#|mailto:)/.test(url)) {
      return match;
    }
    if (url.startsWith("/")) {
      return url.slice(1) === oldFile ? prefix + "/" + newFile + suffix : match;
    }
    const resolved = normalizePath(joinPath(noteDir, url));
    if (resolved === oldFile) {
      return prefix + rebaseUrl(url, noteDir, newFile) + suffix;
    }
    return match;
  });
}

export function rewriteRenamedLinks(
  content,
  oldPath,
  newPath,
  referencingPath,
) {
  return rewriteMarkdownLinks(
    rewriteWikilinks(content, oldPath, newPath),
    oldPath,
    newPath,
    referencingPath,
  );
}

// --- path helpers (mirror the server's POSIX-style logic) ---

function dirOf(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function joinPath(dir, rel) {
  return dir ? dir + "/" + rel : rel;
}

function normalizePath(p) {
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Recompute a relative URL so it points at newPath from noteDir.
function rebaseUrl(url, noteDir, newPath) {
  const from = noteDir ? noteDir.split("/") : [];
  const to = newPath.split("/");
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) {
    i++;
  }
  const up = from.length - i;
  const rest = to.slice(i).join("/");
  if (up === 0) {
    return rest.includes("/") ? rest : "./" + rest;
  }
  return "../".repeat(up) + rest;
}
