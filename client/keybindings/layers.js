// SPDX-License-Identifier: LGPL-3.0-only

/** Keybinding layer definitions — pure data. Nothing here imports an
 * editor or the dispatcher; layers only name actions from the editor
 * action channel (the editor:* and app:* topics). Actions globnotes
 * lacks (Notion slash-menu) is a no-op in every layer.
 *
 * Binding shape: `{ mac, other }` with explicit platform keys (see
 * keys.js). Optional `alias` = secondary key for the same action
 * (muscle-memory aliases). Optional `context: "selection"` +
 * `fallback` = smart binding: the primary action fires only when the
 * editor selection is non-empty, else the fallback action fires.
 */

import { TOPICS } from "../bus/index.js";
import { isMac } from "./keys.js";

// Shorthands. `mod(key)` = Cmd on macOS / Ctrl on Win+Linux (the
// standard editor convention). `same(key)` = identical on all platforms.
// Literal Ctrl on every platform is spelled out via `ctrl(key)`.
const mod = (key) => ({ mac: `Cmd+${key}`, other: `Ctrl+${key}` });
const same = (key) => ({ mac: key, other: key });
const ctrl = (key) => ({ mac: `Ctrl+${key}`, other: `Ctrl+${key}` });

// The platform modifier name for prose descriptions: `MOD` interpolates
// into the description templates so they read natively on every platform.
const MOD = isMac() ? "Cmd" : "Ctrl";

// Cross-layer constants: every other app's new-note key is
// browser-reserved, so globnotes' stable core is Ctrl+Alt+N / Ctrl+Alt+H
// (literal Ctrl, same on all platforms — matches the historical bindings).
const CROSS_LAYER = {
  [TOPICS.APP_NEW_NOTE]: ctrl("Alt+N"),
  [TOPICS.APP_GO_HOME]: ctrl("Alt+H"),
  // Every layer keeps Escape → exit edit (the historical Esc behavior;
  // editors collapse a multi-cursor selection first — see the Esc
  // ordering note in the layer plan).
  [TOPICS.EDITOR_EXIT_EDIT]: same("Escape"),
  // Source-mode find opens the in-editor panel (CM6 searches the whole
  // document, not the viewport DOM). binding:"editor" via ACTIONS — never
  // "app": native browser find stays correct in the other modes.
  [TOPICS.EDITOR_FIND]: mod("F"),
};

const legacyBindings = {
  ...CROSS_LAYER,
  [TOPICS.EDITOR_TOGGLE_EDIT]: same("E"),
  [TOPICS.EDITOR_SAVE]: mod("Enter"),
  // The rewrite dropped the Flatnotes/upstream quick-switcher key;
  // Legacy restores it. Bare key → Mousetrap plain bind, so it never
  // fires while typing in the editors or search inputs.
  [TOPICS.APP_OPEN_SWITCHER]: same("/"),
};

export const LAYERS = {
  legacy: {
    id: "legacy",
    label: "Legacy Flatnotes",
    description:
      `The original Flatnotes keymap: E to edit, ${MOD}+Enter to save, ` +
      `/ for the quick switcher.`,
    bindings: legacyBindings,
  },
  obsidian: {
    id: "obsidian",
    label: "Obsidian",
    description:
      `${MOD}+E toggles edit/view, ${MOD}+O the switcher, ${MOD}+K link, ` +
      `${MOD}+Alt+1..6 headings. Inline code loses its WYSIWYG ${MOD}+E ` +
      `default (Obsidian doesn't bind inline code). Actions globnotes ` +
      `lacks the slash menu.`,
    bindings: {
      ...CROSS_LAYER,
      [TOPICS.EDITOR_SAVE]: { ...mod("S"), alias: mod("Enter") },
      [TOPICS.EDITOR_TOGGLE_EDIT]: mod("E"),
      [TOPICS.APP_OPEN_SWITCHER]: mod("O"),
      [TOPICS.APP_OPEN_PALETTE]: mod("P"),
      [TOPICS.EDITOR_INSERT_LINK]: mod("K"),
      [TOPICS.EDITOR_HEADING_1]: mod("Alt+1"),
      [TOPICS.EDITOR_HEADING_2]: mod("Alt+2"),
      [TOPICS.EDITOR_HEADING_3]: mod("Alt+3"),
      [TOPICS.EDITOR_HEADING_4]: mod("Alt+4"),
      [TOPICS.EDITOR_HEADING_5]: mod("Alt+5"),
      [TOPICS.EDITOR_HEADING_6]: mod("Alt+6"),
    },
  },
  notion: {
    id: "notion",
    label: "Notion",
    description:
      `${MOD}+P opens the switcher (${MOD}+K inserts a link with a ` +
      `selection, switcher otherwise), ${MOD}+E inline code, ` +
      `${MOD}+Shift+S strikethrough, Tab/Shift+Tab block indent. ` +
      `/ (slash menu) is a no-op — globnotes has no slash menu.`,
    bindings: {
      ...CROSS_LAYER,
      [TOPICS.EDITOR_SAVE]: { ...mod("S"), alias: mod("Enter") },
      [TOPICS.APP_OPEN_SWITCHER]: mod("P"),
      [TOPICS.EDITOR_INSERT_LINK]: {
        ...mod("K"),
        context: "selection",
        fallback: TOPICS.APP_OPEN_SWITCHER,
      },
      [TOPICS.EDITOR_TOGGLE_INLINE_CODE]: mod("E"),
      [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH]: mod("Shift+S"),
      [TOPICS.EDITOR_HEADING_1]: { mac: "Cmd+Alt+1", other: "Ctrl+Shift+1" },
      [TOPICS.EDITOR_HEADING_2]: { mac: "Cmd+Alt+2", other: "Ctrl+Shift+2" },
      [TOPICS.EDITOR_HEADING_3]: { mac: "Cmd+Alt+3", other: "Ctrl+Shift+3" },
      [TOPICS.EDITOR_LIST_INDENT]: same("Tab"),
      [TOPICS.EDITOR_LIST_OUTDENT]: same("Shift+Tab"),
    },
  },
  typora: {
    id: "typora",
    label: "Typora",
    description:
      `${MOD}+S saves, ${MOD}+1..6 headings, ${MOD}+Shift+K code fence, ` +
      `${MOD}+Shift+Q quote, ${MOD}+Shift+\` inline code, ${MOD}+K link, ` +
      `${MOD}+/ toggles source mode. Browser-reserved keys (${MOD}+N/T/W) ` +
      `fall back to the cross-layer Ctrl+Alt+N/H constants.`,
    bindings: {
      ...CROSS_LAYER,
      [TOPICS.EDITOR_SAVE]: { ...mod("S"), alias: mod("Enter") },
      [TOPICS.EDITOR_CODE_BLOCK]: mod("Shift+K"),
      [TOPICS.EDITOR_BLOCKQUOTE]: mod("Shift+Q"),
      [TOPICS.EDITOR_TOGGLE_INLINE_CODE]: mod("Shift+`"),
      [TOPICS.EDITOR_INSERT_LINK]: mod("K"),
      [TOPICS.EDITOR_TOGGLE_SOURCE_MODE]: mod("/"),
      [TOPICS.EDITOR_HEADING_1]: mod("1"),
      [TOPICS.EDITOR_HEADING_2]: mod("2"),
      [TOPICS.EDITOR_HEADING_3]: mod("3"),
      [TOPICS.EDITOR_HEADING_4]: mod("4"),
      [TOPICS.EDITOR_HEADING_5]: mod("5"),
      [TOPICS.EDITOR_HEADING_6]: mod("6"),
    },
  },
  "vscode-lite": {
    id: "vscode-lite",
    label: "VS Code-lite",
    description:
      `${MOD}+S saves, ${MOD}+P quick open, ${MOD}+B/I bold/italic, Alt+S ` +
      `strikethrough, Alt+C checklist toggle. Line operations keep the ` +
      `source editor defaults.`,
    bindings: {
      ...CROSS_LAYER,
      [TOPICS.EDITOR_SAVE]: { ...mod("S"), alias: mod("Enter") },
      [TOPICS.APP_OPEN_SWITCHER]: mod("P"),
      [TOPICS.APP_OPEN_PALETTE]: mod("Shift+P"),
      [TOPICS.EDITOR_TOGGLE_BOLD]: mod("B"),
      [TOPICS.EDITOR_TOGGLE_ITALIC]: mod("I"),
      [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH]: same("Alt+S"),
      [TOPICS.EDITOR_CHECKLIST_TOGGLE]: same("Alt+C"),
    },
  },
};

/** The Custom layer starts as a copy of Legacy; per-binding overrides are
 * persisted by the store (store.js) and merged on top of this base. */
export const CUSTOM_LAYER_ID = "custom";
export const CUSTOM_BASE_LAYER_ID = "legacy";
export const LEGACY_LAYER_ID = "legacy";

export const LAYER_ORDER = [
  "legacy",
  "obsidian",
  "notion",
  "typora",
  "vscode-lite",
  CUSTOM_LAYER_ID,
];

/** Action metadata: human label for the cheat sheet, which binding
 * mechanism resolves the key ("app" = dispatcher/Mousetrap, "editor" =
 * the mounted editor's keymap), and cheat-sheet group. */
export const ACTIONS = {
  [TOPICS.EDITOR_SAVE]: {
    label: "Save note",
    binding: "editor",
    group: "Editing",
  },
  [TOPICS.EDITOR_SAVE_CLOSE]: {
    label: "Save and close",
    binding: "editor",
    group: "Editing",
  },
  [TOPICS.EDITOR_EXIT_EDIT]: {
    label: "Exit edit mode",
    binding: "editor",
    group: "Editing",
  },
  [TOPICS.EDITOR_FIND]: {
    label: "Find in note",
    binding: "editor",
    group: "Editing",
  },
  [TOPICS.EDITOR_TOGGLE_EDIT]: {
    label: "Edit / view note",
    binding: "app",
    group: "Editing",
  },
  [TOPICS.EDITOR_TOGGLE_SOURCE_MODE]: {
    label: "Toggle source mode",
    binding: "app",
    group: "Editing",
  },

  [TOPICS.EDITOR_TOGGLE_BOLD]: {
    label: "Toggle bold",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_TOGGLE_ITALIC]: {
    label: "Toggle italic",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH]: {
    label: "Toggle strikethrough",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_TOGGLE_INLINE_CODE]: {
    label: "Toggle inline code",
    binding: "editor",
    group: "Formatting",
  },
  // App-level so the dispatcher can resolve selection-context smart
  // bindings (Notion's Mod+K) and so the key works regardless of editor
  // focus; the mounted editor reacts to the published action.
  [TOPICS.EDITOR_INSERT_LINK]: {
    label: "Insert link",
    binding: "app",
    group: "Formatting",
  },
  [TOPICS.EDITOR_HEADING_1]: {
    label: "Heading 1",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_HEADING_2]: {
    label: "Heading 2",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_HEADING_3]: {
    label: "Heading 3",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_HEADING_4]: {
    label: "Heading 4",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_HEADING_5]: {
    label: "Heading 5",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_HEADING_6]: {
    label: "Heading 6",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_PARAGRAPH]: {
    label: "Paragraph",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_BULLET_LIST]: {
    label: "Bullet list",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_ORDERED_LIST]: {
    label: "Ordered list",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_CHECKLIST_TOGGLE]: {
    label: "Checklist toggle",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_CODE_BLOCK]: {
    label: "Code block",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_BLOCKQUOTE]: {
    label: "Blockquote",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_UNDO]: {
    label: "Undo",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_REDO]: {
    label: "Redo",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_HARD_BREAK]: {
    label: "Hard line break",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_LIST_INDENT]: {
    label: "Indent list item",
    binding: "editor",
    group: "Formatting",
  },
  [TOPICS.EDITOR_LIST_OUTDENT]: {
    label: "Outdent list item",
    binding: "editor",
    group: "Formatting",
  },

  [TOPICS.APP_NEW_NOTE]: { label: "New note", binding: "app", group: "App" },
  [TOPICS.APP_GO_HOME]: { label: "Go home", binding: "app", group: "App" },
  [TOPICS.APP_OPEN_SWITCHER]: {
    label: "Open quick switcher",
    binding: "app",
    group: "App",
  },
  [TOPICS.APP_OPEN_PALETTE]: {
    label: "Command palette",
    binding: "app",
    group: "App",
  },
};
