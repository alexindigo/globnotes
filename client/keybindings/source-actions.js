// SPDX-License-Identifier: LGPL-3.0-only

/** Markdown-syntax actions for the source editor.
 *
 * The keybinding layers' formatting actions stay real in source mode by
 * editing the markdown text directly (Typora's approach) instead of
 * no-oping: bold wraps `**sel**`, headings rewrite line prefixes, etc.
 * Pure functions over a CodeMirror 6 EditorView (or anything exposing
 * `.state` / `.dispatch`), so they unit-test without a mounted editor.
 */

import { redo, undo } from "@codemirror/commands";

// ---------------------------------------------------------------------------
// Line-prefix helpers (headings, lists, quotes operate on whole lines)
// ---------------------------------------------------------------------------

const PREFIX_PATTERNS = {
  heading: /^#{1,6}(?= |\t|$)/,
  bullet: /^[-*+](?! \[)(?= |\t|$)/,
  ordered: /^\d+[.)](?= |\t|$)/,
  checklist: /^[-*+] \[( |x|X)\](?= |\t|$)/,
  quote: /^>(?= |$)/,
};

/** Every doc line touched by the selection, deduplicated, in order. */
function selectedLines(state) {
  const lines = [];
  const seen = new Set();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (!seen.has(n)) {
        seen.add(n);
        lines.push(state.doc.line(n));
      }
    }
  }
  return lines;
}

function changeLines(view, lines, transform) {
  const changes = [];
  let firstFrom = null;
  for (const line of lines) {
    const insert = transform(line.text);
    if (insert === null) continue;
    if (firstFrom === null) firstFrom = line.from;
    changes.push({ from: line.from, to: line.to, insert });
  }
  if (changes.length) view.dispatch({ changes });
  return firstFrom;
}

/** Strip any block prefix this module recognizes. */
function stripPrefix(text) {
  const m = text.match(/^(\s*)(#{1,6} |[-*+] (\[[ xX]\] )?|\d+[.)] |> )?/);
  return text.slice(m ? m[0].length : 0);
}

function toggleLinePrefix(view, marker, pattern) {
  changeLines(view, selectedLines(view.state), (text) => {
    const indent = text.match(/^\s*/)[0];
    const body = text.slice(indent.length);
    if (pattern.test(body)) {
      return indent + body.replace(pattern, "").replace(/^ /, "");
    }
    return indent + marker + stripPrefix(body);
  });
}

// ---------------------------------------------------------------------------
// Actions (each takes the editor view)
// ---------------------------------------------------------------------------

/** Toggle a wrap marker (bold `**`, italic `*`, strike `~~`, code `` ` ``)
 * around the selection: unwraps when the marker already hugs the selection
 * or the selected text starts/ends with it. */
export function toggleWrap(view, marker) {
  const { state } = view;
  const range = state.selection.main;
  const len = marker.length;
  const text = state.doc.sliceString(range.from, range.to);
  const before = state.doc.sliceString(
    Math.max(0, range.from - len),
    range.from,
  );
  const after = state.doc.sliceString(
    range.to,
    Math.min(state.doc.length, range.to + len),
  );
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: range.from - len, to: range.from, insert: "" },
        { from: range.to, to: range.to + len, insert: "" },
      ],
      selection: { anchor: range.from - len, head: range.to - len },
    });
  } else if (
    text.length >= len * 2 &&
    text.startsWith(marker) &&
    text.endsWith(marker)
  ) {
    const inner = text.slice(len, text.length - len);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: inner },
      selection: { anchor: range.from, head: range.from + inner.length },
    });
  } else {
    view.dispatch({
      changes: {
        from: range.from,
        to: range.to,
        insert: marker + text + marker,
      },
      selection: {
        anchor: range.from + len,
        head: range.from + len + text.length,
      },
    });
  }
  view.focus();
}

/** Set (or toggle off, when already at that level) a heading on the
 * selected lines. level 0 = paragraph. */
export function setHeading(view, level) {
  changeLines(view, selectedLines(view.state), (text) => {
    const indent = text.match(/^\s*/)[0];
    const body = text.slice(indent.length);
    const stripped = stripPrefix(body);
    const current = body.match(/^#{1,6}(?= |$)/);
    if (current && current[0].length === level) {
      return indent + stripped;
    }
    if (level < 1) return indent + stripped;
    return indent + "#".repeat(level) + " " + stripped;
  });
  view.focus();
}

export function toggleBulletList(view) {
  toggleLinePrefix(view, "- ", PREFIX_PATTERNS.bullet);
  view.focus();
}

export function toggleOrderedList(view) {
  toggleLinePrefix(view, "1. ", PREFIX_PATTERNS.ordered);
  view.focus();
}

/** Toggle a checklist on the selected lines: plain text gains `- [ ] `,
 * a checklist flips its checkbox, other lists convert. */
export function toggleChecklist(view) {
  changeLines(view, selectedLines(view.state), (text) => {
    const indent = text.match(/^\s*/)[0];
    const body = text.slice(indent.length);
    const check = body.match(PREFIX_PATTERNS.checklist);
    if (check) {
      const next = check[1] === " " ? "x" : " ";
      return (
        indent + `- [${next}] ` + body.slice(check[0].length).replace(/^\s/, "")
      );
    }
    const bullet = body.match(PREFIX_PATTERNS.bullet) ||
      body.match(PREFIX_PATTERNS.ordered);
    if (bullet) {
      return indent + "- [ ] " + body.slice(bullet[0].length).replace(/^ /, "");
    }
    return indent + "- [ ] " + stripPrefix(body);
  });
  view.focus();
}

export function toggleBlockquote(view) {
  toggleLinePrefix(view, "> ", PREFIX_PATTERNS.quote);
  view.focus();
}

/** Wrap the selection in a fenced code block (empty selection inserts a
 * bare fence pair with the cursor inside). */
export function toggleCodeBlock(view) {
  const { state } = view;
  const range = state.selection.main;
  const text = state.doc.sliceString(range.from, range.to);
  const insert = text
    ? "```\n" + text + "\n```"
    : "```\n\n```";
  const cursor = range.from + (text ? insert.length : 4);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: cursor },
  });
  view.focus();
}

/** Wrap the selection in `[text]()` with the cursor on the empty href. */
export function insertLink(view) {
  const { state } = view;
  const range = state.selection.main;
  const text = state.doc.sliceString(range.from, range.to);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[${text}]()` },
    selection: { anchor: range.from + text.length + 3 },
  });
  view.focus();
}

/** Insert a markdown hard break (two trailing spaces + newline). */
export function insertHardBreak(view) {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: "  \n" } });
  view.focus();
}

/** Indent every selected line by two spaces (list nesting in source). */
export function indentLines(view) {
  changeLines(view, selectedLines(view.state), (text) => "  " + text);
  view.focus();
}

/** Outdent every selected line by up to two leading spaces. */
export function outdentLines(view) {
  changeLines(view, selectedLines(view.state), (text) =>
    text.replace(/^ {1,2}/, ""));
  view.focus();
}

export function undoAction(view) {
  undo(view);
  view.focus();
}

export function redoAction(view) {
  redo(view);
  view.focus();
}
