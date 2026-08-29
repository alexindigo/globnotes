export function notePath(path) {
  // Notes live in the root url space; encode per segment so slashes stay
  // real (named-route params would percent-encode them).
  return "/" + path.split("/").map(encodeURIComponent).join("/");
}
