const FORBIDDEN_CHARS = /[<>:"\\|?*]/;
const MAX_SEGMENT_BYTES = 255;

export function notePathError(path) {
  if (!path) {
    return "Path cannot be empty.";
  }
  if (path[0] === "/") {
    return "Path cannot start with '/'.";
  }
  const segments = path.split("/");
  if (path.endsWith("/")) {
    return "Path cannot contain an empty folder segment (ends with '/').";
  }
  if (segments[0] === "_") {
    return "Path cannot start with '_/' (reserved for app URLs).";
  }
  for (const segment of segments) {
    if (!segment) {
      return "Path cannot contain an empty folder segment.";
    }
    if (segment === "." || segment === "..") {
      return "Path cannot contain '.' or '..' path segments.";
    }
    if (segment.startsWith(".")) {
      return "Path path segments cannot start with '.'.";
    }
    if (FORBIDDEN_CHARS.test(segment)) {
      return "Path cannot include any of the following characters: <>:\"\\|?*";
    }
    if (new TextEncoder().encode(segment).length > MAX_SEGMENT_BYTES) {
      return "Path path segments cannot exceed 255 bytes.";
    }
  }
  return null;
}
