import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { TOPICS } from "../bus/index.js";
import { sourceActionMap } from "../sourceEditorActions.js";

function editor(text) {
  const view = {
    state: EditorState.create({ doc: text, selection: EditorSelection.range(0, text.length), extensions: [history()] }),
    dispatch(spec) { view.state = view.state.update(spec).state; },
    focus: vi.fn(),
  };
  return view;
}

describe("source editor topic adapters", () => {
  it.each([
    [TOPICS.EDITOR_TOGGLE_BOLD, "word", "**word**"],
    [TOPICS.EDITOR_TOGGLE_ITALIC, "word", "*word*"],
    [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH, "word", "~~word~~"],
    [TOPICS.EDITOR_TOGGLE_INLINE_CODE, "word", "`word`"],
    [TOPICS.EDITOR_INSERT_LINK, "word", "[word]()"],
    [TOPICS.EDITOR_HEADING_1, "word", "# word"],
    [TOPICS.EDITOR_HEADING_2, "word", "## word"],
    [TOPICS.EDITOR_HEADING_3, "word", "### word"],
    [TOPICS.EDITOR_HEADING_4, "word", "#### word"],
    [TOPICS.EDITOR_HEADING_5, "word", "##### word"],
    [TOPICS.EDITOR_HEADING_6, "word", "###### word"],
    [TOPICS.EDITOR_PARAGRAPH, "## word", "word"],
    [TOPICS.EDITOR_BULLET_LIST, "word", "- word"],
    [TOPICS.EDITOR_ORDERED_LIST, "word", "1. word"],
    [TOPICS.EDITOR_CHECKLIST_TOGGLE, "word", "- [ ] word"],
    [TOPICS.EDITOR_CODE_BLOCK, "word", "```\nword\n```"],
    [TOPICS.EDITOR_BLOCKQUOTE, "word", "> word"],
    [TOPICS.EDITOR_HARD_BREAK, "word", "word  \n"],
    [TOPICS.EDITOR_LIST_INDENT, "word", "  word"],
    [TOPICS.EDITOR_LIST_OUTDENT, "  word", "word"],
  ])("%s produces the supported markdown edit", (topic, before, after) => {
    const view = editor(before);
    sourceActionMap[topic](view);
    expect(view.state.doc.toString()).toBe(after);
    expect(view.focus).toHaveBeenCalledOnce();
  });
  it("undo and redo target the source history rather than session saving", () => {
    const view = editor("word");
    sourceActionMap[TOPICS.EDITOR_TOGGLE_BOLD](view);
    sourceActionMap[TOPICS.EDITOR_UNDO](view);
    expect(view.state.doc.toString()).toBe("word");
    sourceActionMap[TOPICS.EDITOR_REDO](view);
    expect(view.state.doc.toString()).toBe("**word**");
    expect(sourceActionMap[TOPICS.EDITOR_SAVE]).toBeUndefined();
    expect(sourceActionMap[TOPICS.EDITOR_EXIT_EDIT]).toBeUndefined();
  });
});
