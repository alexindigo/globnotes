// SPDX-License-Identifier: LGPL-3.0-only
import { TOPICS } from "./bus/index.js";

// The inner editor executes commands; the wrapper owns link-popover DOM glue.
export const wysiwygCommandMap = {
  [TOPICS.EDITOR_TOGGLE_BOLD]: "bold",
  [TOPICS.EDITOR_TOGGLE_ITALIC]: "italic",
  [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH]: "strike",
  [TOPICS.EDITOR_TOGGLE_INLINE_CODE]: "inlineCode",
  [TOPICS.EDITOR_HEADING_1]: "h1",
  [TOPICS.EDITOR_HEADING_2]: "h2",
  [TOPICS.EDITOR_HEADING_3]: "h3",
  [TOPICS.EDITOR_HEADING_4]: "h4",
  [TOPICS.EDITOR_HEADING_5]: "h5",
  [TOPICS.EDITOR_HEADING_6]: "h6",
  [TOPICS.EDITOR_PARAGRAPH]: "paragraph",
  [TOPICS.EDITOR_BULLET_LIST]: "bulletList",
  [TOPICS.EDITOR_ORDERED_LIST]: "orderedList",
  [TOPICS.EDITOR_CHECKLIST_TOGGLE]: "checklist",
  [TOPICS.EDITOR_CODE_BLOCK]: "codeBlock",
  [TOPICS.EDITOR_BLOCKQUOTE]: "blockquote",
  [TOPICS.EDITOR_UNDO]: "undo",
  [TOPICS.EDITOR_REDO]: "redo",
  [TOPICS.EDITOR_HARD_BREAK]: "hardBreak",
  [TOPICS.EDITOR_LIST_INDENT]: "listIndent",
  [TOPICS.EDITOR_LIST_OUTDENT]: "listOutdent",
};

export const wysiwygToolbarActionMap = {
  [TOPICS.EDITOR_INSERT_LINK]: "openLinkPopover",
};
