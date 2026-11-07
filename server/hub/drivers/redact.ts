// SPDX-License-Identifier: LGPL-3.0-only
import { encodeBase64 } from "@std/encoding/base64";

/** One pass, longest match first: replacements never get reprocessed by a
 * shorter key. Recreate on rotation; no key is written into a diagnostic. */
export function driverRedactor(
  values: readonly string[],
): (text: string) => string {
  const forms = [
    ...new Set(
      values.filter(Boolean).flatMap((value) => [
        value,
        encodeURIComponent(value),
        encodeBase64(new TextEncoder().encode(value)),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!forms.length) return (text) => text;
  const pattern = new RegExp(
    forms.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(
      "|",
    ),
    "g",
  );
  return (text) => text.replace(pattern, "[secret]");
}
