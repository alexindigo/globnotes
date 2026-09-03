// Unit tests for the source-mode markdown actions: pure functions over a
// CM6 view, exercised here through a real EditorView in jsdom.
import { describe, expect, it } from "vitest";
import { history } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  insertHardBreak,
  insertLink,
  indentLines,
  outdentLines,
  setHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleChecklist,
  toggleCodeBlock,
  toggleOrderedList,
  toggleWrap,
  undoAction,
} from "../keybindings/source-actions.js";

// jsdom's Range lacks the client-rect APIs CM6's async measurement cycle
// touches; stub them with empty geometry so measure is a no-op.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: 0,
    height: 0,
  });
}

function makeView(doc, from, to) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [history()] }),
  });
  view.dispatch({
    selection: EditorSelection.range(from ?? 0, to ?? doc.length),
  });
  return view;
}

function text(view) {
  return view.state.doc.toString();
}

describe("source-actions", () => {
  it("wraps and unwraps bold around the selection", () => {
    const view = makeView("hello world", 6, 11);
    toggleWrap(view, "**");
    expect(text(view)).toBe("hello **world**");
    // Selection hugs the markers now; a second run unwraps.
    const range = view.state.selection.main;
    expect(text(view).slice(range.from - 2, range.from)).toBe("**");
    toggleWrap(view, "**");
    expect(text(view)).toBe("hello world");
  });

  it("unwraps when the selected text already carries the marker", () => {
    const view = makeView("hello **world**", 6, 15);
    toggleWrap(view, "**");
    expect(text(view)).toBe("hello world");
  });

  it("sets and toggles headings", () => {
    const view = makeView("Title");
    setHeading(view, 2);
    expect(text(view)).toBe("## Title");
    setHeading(view, 2);
    expect(text(view)).toBe("Title");
    setHeading(view, 1);
    expect(text(view)).toBe("# Title");
    // Paragraph strips any prefix.
    setHeading(view, 0);
    expect(text(view)).toBe("Title");
  });

  it("replaces an existing heading level", () => {
    const view = makeView("# Title");
    setHeading(view, 3);
    expect(text(view)).toBe("### Title");
  });

  it("toggles bullet and ordered list prefixes", () => {
    const view = makeView("item");
    toggleBulletList(view);
    expect(text(view)).toBe("- item");
    toggleBulletList(view);
    expect(text(view)).toBe("item");
    toggleOrderedList(view);
    expect(text(view)).toBe("1. item");
  });

  it("adds and flips checklist items", () => {
    const view = makeView("task");
    toggleChecklist(view);
    expect(text(view)).toBe("- [ ] task");
    toggleChecklist(view);
    expect(text(view)).toBe("- [x] task");
    toggleChecklist(view);
    expect(text(view)).toBe("- [ ] task");
  });

  it("converts a bullet into a checklist item", () => {
    const view = makeView("- task");
    toggleChecklist(view);
    expect(text(view)).toBe("- [ ] task");
  });

  it("toggles blockquote prefixes", () => {
    const view = makeView("quoted");
    toggleBlockquote(view);
    expect(text(view)).toBe("> quoted");
    toggleBlockquote(view);
    expect(text(view)).toBe("quoted");
  });

  it("wraps the selection in a fenced code block", () => {
    const view = makeView("code here", 0, 9);
    toggleCodeBlock(view);
    expect(text(view)).toBe("```\ncode here\n```");
  });

  it("wraps the selection in a link and selects the empty href", () => {
    const view = makeView("label", 0, 5);
    insertLink(view);
    expect(text(view)).toBe("[label]()");
    expect(view.state.selection.main.head).toBe(8);
  });

  it("indents and outdents selected lines", () => {
    const view = makeView("a\nb");
    indentLines(view);
    expect(text(view)).toBe("  a\n  b");
    outdentLines(view);
    expect(text(view)).toBe("a\nb");
  });

  it("inserts a hard break at the cursor", () => {
    const view = makeView("ab", 1, 1);
    insertHardBreak(view);
    expect(text(view)).toBe("a  \nb");
  });

  it("undo reverts a formatting action", () => {
    const view = makeView("item");
    toggleBulletList(view);
    expect(text(view)).toBe("- item");
    undoAction(view);
    expect(text(view)).toBe("item");
  });
});
