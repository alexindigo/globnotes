export function notePath(title) {
  // Notes live in the root url space; encode per segment so slashes stay
  // real (named-route params would percent-encode them).
  return "/" + title.split("/").map(encodeURIComponent).join("/");
}
