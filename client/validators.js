const FORBIDDEN_CHARS = /[<>:"\\|?*]/;
const MAX_SEGMENT_BYTES = 255;

export function noteTitleError(title) {
  if (!title) {
    return "Title cannot be empty.";
  }
  if (title[0] === "/") {
    return "Title cannot start with '/'.";
  }
  const segments = title.split("/");
  if (title.endsWith("/")) {
    return "Title cannot contain an empty folder segment (ends with '/').";
  }
  if (segments[0] === "_") {
    return "Title cannot start with '_/' (reserved for app URLs).";
  }
  for (const segment of segments) {
    if (!segment) {
      return "Title cannot contain an empty folder segment.";
    }
    if (segment === "." || segment === "..") {
      return "Title cannot contain '.' or '..' path segments.";
    }
    if (segment.startsWith(".")) {
      return "Title path segments cannot start with '.'.";
    }
    if (FORBIDDEN_CHARS.test(segment)) {
      return "Title cannot include any of the following characters: <>:\"\\|?*";
    }
    if (new TextEncoder().encode(segment).length > MAX_SEGMENT_BYTES) {
      return "Title path segments cannot exceed 255 bytes.";
    }
  }
  return null;
}
