import { params } from "./constants.js";
import { directoryFromPath } from "./helpers.js";

export function notePath(path) {
  // Notes live in the root url space; encode per segment so slashes stay
  // real (named-route params would percent-encode them).
  return "/" + path.split("/").map(encodeURIComponent).join("/");
}

/** Document URLs include the history base; router path strings must not. */
export function appRelativePath(pathname, base) {
  const prefix = base.replace(/\/$/, "");
  return prefix && (pathname === prefix || pathname.startsWith(prefix + "/"))
    ? pathname.slice(prefix.length) || "/"
    : pathname;
}

export function basenameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinNotePath(folder, basename) {
  return folder ? folder + "/" + basename : basename;
}

/** Folder breadcrumbs, retaining two sections either side for long paths. */
export function pathBreadcrumbs(folder) {
  if (!folder) return [];
  const parts = folder.split("/");
  const toCrumb = (label, i) => ({
    label,
    folder: parts.slice(0, i + 1).join("/"),
  });
  if (folder.length <= 60) return parts.map(toCrumb);
  const lead = parts.slice(0, 2).map(toCrumb);
  const trail = parts
    .slice(-2)
    .map((label, i) => toCrumb(label, parts.length - 2 + i));
  return [...lead, { ellipsis: true }, ...trail];
}

/** Pass query explicitly to retain the term and sort of a scoped search. */
export function folderSearchTarget(folder, query = { [params.searchTerm]: "*" }) {
  return {
    name: "search",
    query: folder === undefined
      ? { ...query }
      : { ...query, [params.folder]: folder },
  };
}

/** An explicit path creates a missing wikilink; otherwise use route context. */
export function newNoteTarget(options = {}) {
  if ("path" in options) return { name: "new", query: { path: options.path } };
  const route = options.route;
  if (route?.name === "search" && route.query[params.folder]) {
    return { name: "new", query: { folder: route.query[params.folder] } };
  }
  if (route?.name === "note" && route.params.path) {
    const folder = directoryFromPath(route.params.path);
    return folder ? { name: "new", query: { folder } } : { name: "new" };
  }
  return { name: "new" };
}

/** Encoded JSON for a raw URL query; the router decodes the URL on receipt. */
export function encodeRewriteFiles(files) {
  return encodeURIComponent(JSON.stringify(files));
}

export function decodeRewriteFiles(raw) {
  try {
    if (!raw) return [];
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return [];
  }
}
