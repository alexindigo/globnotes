// SPDX-License-Identifier: LGPL-3.0-only

/** Key notation helpers.
 *
 * Layer data spells keys per-platform with explicit modifiers:
 * `{ mac: "Cmd+S", other: "Ctrl+S" }` — "Cmd"/"Ctrl" always mean the
 * literal platform keys, never Super/Win. Bindings that intentionally use
 * literal Ctrl on macOS too (the cross-layer Ctrl+Alt+N/H constants)
 * simply say "Ctrl" in `mac` as well.
 *
 * Converters translate a resolved platform key into the notation each
 * binding mechanism expects:
 * - Mousetrap: lowercase, "cmd"/"ctrl" modifier names.
 * - CodeMirror 6: dash-separated, "Mod-" = Cmd on macOS / Ctrl elsewhere
 *   (the standard editor-keymap convention — never Super/Win).
 */

export function isMac() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? navigator.userAgent ?? "";
  return /Mac|iPhone|iPad/i.test(platform);
}

/** The key string for the current platform. */
export function platformKey(binding) {
  return isMac() ? binding.mac : binding.other;
}

/** Mousetrap sequence for a resolved key ("Cmd+S" → "cmd+s"). */
export function toMousetrap(key) {
  return key.toLowerCase();
}

/** CodeMirror 6 / ProseMirror key name for a resolved key ("Cmd+S" →
 * "Mod-s", "Ctrl+Shift+K" → "Ctrl-Shift-K"). A letter under Shift must
 * stay uppercase: both libraries build lookup keys from `event.key`,
 * which browsers report uppercase for shift+letter. */
export function toCm6(key) {
  const parts = key.split("+");
  const last = parts[parts.length - 1];
  const shifted = parts.includes("Shift");
  return parts
    .map((part, i) => {
      if (part === "Cmd") return "Mod";
      if (part === "Shift" || part === "Alt" || part === "Ctrl") return part;
      if (i === parts.length - 1 && part.length === 1) {
        return shifted ? part.toUpperCase() : part.toLowerCase();
      }
      return part;
    })
    .join("-");
}

/** A bare key (no modifiers) — "E", "Tab", "Escape". */
export function isBareKey(key) {
  return !key.includes("+");
}
