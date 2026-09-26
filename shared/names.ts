// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Filename rules shared by the server and the client. The one contract:
 * sanitizeBasename — the H1 → filename rule must be identical on both
 * sides (the client follows it live, the server enforces it on save).
 */

/** Sanitize text into a filename basename: strip path-hostile chars,
 * collapse whitespace, drop leading dots, cap at 255 bytes. Returns null
 * when nothing usable remains. */
export function sanitizeBasename(text: string): string | null {
  const stripped = text
    .replace(/[<>:"\\|?/*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!stripped) return null;
  // Segment limit: 255 bytes.
  const encoded = new TextEncoder().encode(stripped);
  const cut = encoded.length > 255
    ? new TextDecoder().decode(encoded.slice(0, 255)).trimEnd()
    : stripped;
  return cut || null;
}
