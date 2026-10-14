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
