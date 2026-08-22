// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Minimal `mimetypes.guess_type` equivalent (Python stdlib behaviour)
 * for the extensions the vault is likely to hold. Returns null when the
 * extension is unknown, matching the Python server's contract so the
 * caller falls back to a forced download.
 */

const KNOWN: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

export function guessType(filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (!ext.includes(".")) return null;
  return KNOWN[ext] ?? null;
}
