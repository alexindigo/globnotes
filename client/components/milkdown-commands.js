// SPDX-License-Identifier: LGPL-3.0-only

/** Milkdown toolbar command map + active-state helpers.
 * Wraps the preset commands into named actions the toolbar can call,
 * and reads the current ProseMirror selection to light up active
 * buttons. Kept framework-free (plain functions over the editor). */

import { commandsCtx, editorViewCtx } from "@milkdown/core";
import {
  createCodeBlockCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { toggleStrikethroughCommand } from "@milkdown/preset-gfm";

/** Name → { call } where call(ctx) dispatches the ProseMirror command. */
const commands = {
  bold: (ctx) => ctx.get(commandsCtx).call(toggleStrongCommand.key),
  italic: (ctx) => ctx.get(commandsCtx).call(toggleEmphasisCommand.key),
  strike: (ctx) => ctx.get(commandsCtx).call(toggleStrikethroughCommand.key),
  inlineCode: (ctx) => ctx.get(commandsCtx).call(toggleInlineCodeCommand.key),
  blockquote: (ctx) =>
    ctx.get(commandsCtx).call(wrapInBlockquoteCommand.key),
  bulletList: (ctx) =>
    ctx.get(commandsCtx).call(wrapInBulletListCommand.key),
  orderedList: (ctx) =>
    ctx.get(commandsCtx).call(wrapInOrderedListCommand.key),
  codeBlock: (ctx) => ctx.get(commandsCtx).call(createCodeBlockCommand.key),
};

/** Dispatch a named command. `h1`/`h2`/`h3` wrap into a heading of that
 * level. Returns false when the editor isn't ready. */
export function callCommand(editor, name) {
  if (!editor) return false;
  editor.action((ctx) => {
    if (name === "h1" || name === "h2" || name === "h3") {
      const level = Number(name.slice(1));
      return ctx.get(commandsCtx).call(wrapInHeadingCommand.key, { level });
    }
    const fn = commands[name];
    if (fn) return fn(ctx);
  });
  return true;
}

/** Read which formatting marks/block nodes are active in the current
 * selection so toolbar buttons can show an active state. */
export function readActive(editor) {
  if (!editor) return {};
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { from, to, empty, $from } = state.selection;
    const hasMark = (mark) => {
      if (!mark) return false;
      if (empty) {
        return !!mark.isInSet(state.storedMarks || $from.marks());
      }
      return state.doc.rangeHasMark(from, to, mark);
    };
    const schema = state.schema;
    return {
      bold: hasMark(schema.marks.strong),
      italic: hasMark(schema.marks.em),
      strike: hasMark(schema.marks.strikethrough),
      inlineCode: hasMark(schema.marks.code),
      heading: (() => {
        const node = findParent($from, "heading")
          || ($from.parent.type.name === "heading" ? $from.parent : null);
        return node ? "h" + (node.attrs.level || 1) : null;
      })(),
      blockquote: !!findParent($from, "blockquote")
        || $from.parent.type.name === "blockquote",
      bulletList: !!findParent($from, "bulletList"),
      orderedList: !!findParent($from, "orderedList"),
      codeBlock: $from.parent.type.name === "code_block",
    };
  });
}

function findParent($pos, type) {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === type) return $pos.node(d);
  }
  return null;
}
