// SPDX-License-Identifier: LGPL-3.0-only
import { openSearchPanel } from "@codemirror/search";
import { TOPICS } from "./bus/index.js";
import * as sourceActions from "./keybindings/source-actions.js";

// Formatting/structure actions supported by the source editor. Session actions
// belong to noteController; unavailable/unsupported topics remain silent no-ops.
export const sourceActionMap = {
  [TOPICS.EDITOR_TOGGLE_BOLD]: (view) => sourceActions.toggleWrap(view, "**"),
  [TOPICS.EDITOR_TOGGLE_ITALIC]: (view) => sourceActions.toggleWrap(view, "*"),
  [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH]: (view) => sourceActions.toggleWrap(view, "~~"),
  [TOPICS.EDITOR_TOGGLE_INLINE_CODE]: (view) => sourceActions.toggleWrap(view, "`"),
  [TOPICS.EDITOR_INSERT_LINK]: sourceActions.insertLink,
  [TOPICS.EDITOR_HEADING_1]: (view) => sourceActions.setHeading(view, 1),
  [TOPICS.EDITOR_HEADING_2]: (view) => sourceActions.setHeading(view, 2),
  [TOPICS.EDITOR_HEADING_3]: (view) => sourceActions.setHeading(view, 3),
  [TOPICS.EDITOR_HEADING_4]: (view) => sourceActions.setHeading(view, 4),
  [TOPICS.EDITOR_HEADING_5]: (view) => sourceActions.setHeading(view, 5),
  [TOPICS.EDITOR_HEADING_6]: (view) => sourceActions.setHeading(view, 6),
  [TOPICS.EDITOR_PARAGRAPH]: (view) => sourceActions.setHeading(view, 0),
  [TOPICS.EDITOR_BULLET_LIST]: sourceActions.toggleBulletList,
  [TOPICS.EDITOR_ORDERED_LIST]: sourceActions.toggleOrderedList,
  [TOPICS.EDITOR_CHECKLIST_TOGGLE]: sourceActions.toggleChecklist,
  [TOPICS.EDITOR_CODE_BLOCK]: sourceActions.toggleCodeBlock,
  [TOPICS.EDITOR_BLOCKQUOTE]: sourceActions.toggleBlockquote,
  [TOPICS.EDITOR_UNDO]: sourceActions.undoAction,
  [TOPICS.EDITOR_REDO]: sourceActions.redoAction,
  [TOPICS.EDITOR_HARD_BREAK]: sourceActions.insertHardBreak,
  [TOPICS.EDITOR_LIST_INDENT]: sourceActions.indentLines,
  [TOPICS.EDITOR_LIST_OUTDENT]: sourceActions.outdentLines,
  [TOPICS.EDITOR_FIND]: openSearchPanel,
};
