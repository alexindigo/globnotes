import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { commandsCtx, editorViewCtx } from "@milkdown/core";
import * as commonmark from "@milkdown/preset-commonmark";
import { toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import { undoCommand, redoCommand } from "@milkdown/plugin-history";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { publish, TOPICS } from "../bus/index.js";
import { registerModal } from "../modalState.js";
import { wysiwygCommandMap, wysiwygToolbarActionMap } from "../wysiwygEditorActions.js";
import { callCommand } from "../components/milkdown-commands.js";
import MarkdownEditor from "../components/MarkdownEditor.vue";
import WysiwygEditorInner from "../components/WysiwygEditorInner.vue";
import WysiwygEditor from "../components/WysiwygEditor.vue";

const fixture = vi.hoisted(() => ({ editor: null, openLinkPopover: vi.fn() }));
vi.mock("../pluginLoader.js", () => ({ loadClientPlugins: async () => [] }));
vi.mock("@milkdown/vue", () => ({
  Milkdown: { render: () => null },
  MilkdownProvider: { template: "<slot />" },
  useEditor: () => ({ get: () => fixture.editor }),
}));

let wrapper, modal;
afterEach(() => { wrapper?.unmount(); wrapper = null; modal?.dispose(); modal = null; fixture.editor = null; vi.clearAllMocks(); });
function editor() {
  const commands = { call: vi.fn() }, view = { focus: vi.fn() };
  const context = { get: key => key === commandsCtx ? commands : key === editorViewCtx ? view : undefined };
  return { commands, view, action: fn => fn(context) };
}
const commands = [
  [TOPICS.EDITOR_TOGGLE_BOLD, commonmark.toggleStrongCommand],
  [TOPICS.EDITOR_TOGGLE_ITALIC, commonmark.toggleEmphasisCommand],
  [TOPICS.EDITOR_TOGGLE_STRIKETHROUGH, toggleStrikethroughCommand],
  [TOPICS.EDITOR_TOGGLE_INLINE_CODE, commonmark.toggleInlineCodeCommand],
  [TOPICS.EDITOR_PARAGRAPH, commonmark.turnIntoTextCommand],
  [TOPICS.EDITOR_BULLET_LIST, commonmark.wrapInBulletListCommand],
  [TOPICS.EDITOR_ORDERED_LIST, commonmark.wrapInOrderedListCommand],
  [TOPICS.EDITOR_CODE_BLOCK, commonmark.createCodeBlockCommand],
  [TOPICS.EDITOR_BLOCKQUOTE, commonmark.wrapInBlockquoteCommand],
  [TOPICS.EDITOR_UNDO, undoCommand], [TOPICS.EDITOR_REDO, redoCommand],
  [TOPICS.EDITOR_HARD_BREAK, commonmark.insertHardbreakCommand],
  [TOPICS.EDITOR_LIST_INDENT, commonmark.sinkListItemCommand],
  [TOPICS.EDITOR_LIST_OUTDENT, commonmark.liftListItemCommand],
];

describe("WYSIWYG plain-module topic adapters", () => {
  it.each(commands)("%s reaches the matching Milkdown command", (topic, command) => {
    const target = editor();
    expect(callCommand(target, wysiwygCommandMap[topic])).toBe(true);
    expect(target.commands.call).toHaveBeenCalledExactlyOnceWith(command.key);
    expect(target.view.focus).toHaveBeenCalledOnce();
  });
  it.each([1, 2, 3, 4, 5, 6])("heading %s passes its level to the heading command", level => {
    const target = editor();
    callCommand(target, wysiwygCommandMap[TOPICS[`EDITOR_HEADING_${level}`]]);
    expect(target.commands.call).toHaveBeenCalledExactlyOnceWith(commonmark.wrapInHeadingCommand.key, { level });
  });
  it("checklist dispatches the list item's checkbox toggle", () => {
    const target = editor(), transaction = { setNodeMarkup: vi.fn().mockReturnThis() };
    target.view.state = { tr: transaction, selection: { $from: { depth: 1, node: () => ({ type: { name: "list_item" }, attrs: { checked: false } }), before: () => 7 } } };
    target.view.dispatch = vi.fn();
    callCommand(target, wysiwygCommandMap[TOPICS.EDITOR_CHECKLIST_TOGGLE]);
    expect(transaction.setNodeMarkup).toHaveBeenCalledExactlyOnceWith(7, null, { checked: true });
    expect(target.view.dispatch).toHaveBeenCalledWith(transaction);
    expect(wysiwygCommandMap[TOPICS.EDITOR_INSERT_LINK]).toBeUndefined();
    expect(wysiwygToolbarActionMap).toEqual({ [TOPICS.EDITOR_INSERT_LINK]: "openLinkPopover" });
  });
});

describe("mounted editor action wiring", () => {
  it("source edits and find reach the mounted editor, respect modal ownership and unsubscribe", () => {
    wrapper = mount(MarkdownEditor, { props: { initialValue: "word" } });
    const view = EditorView.findFromDOM(wrapper.element.querySelector(".cm-editor"));
    view.dispatch({ selection: EditorSelection.range(0, 4) });
    publish(TOPICS.EDITOR_TOGGLE_BOLD);
    expect(wrapper.vm.getMarkdown()).toBe("**word**");
    modal = registerModal({ name: "fixture" });
    publish(TOPICS.EDITOR_TOGGLE_ITALIC); publish(TOPICS.EDITOR_FIND);
    expect(wrapper.vm.getMarkdown()).toBe("**word**");
    expect(wrapper.find(".cm-search").exists()).toBe(false);
    modal.dispose(); modal = null;
    publish(TOPICS.EDITOR_FIND);
    expect(wrapper.find(".cm-search").exists()).toBe(true);
    const dispatch = vi.spyOn(view, "dispatch");
    wrapper.unmount(); wrapper = null; dispatch.mockClear();
    publish(TOPICS.EDITOR_TOGGLE_BOLD); publish(TOPICS.EDITOR_FIND);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("inner commands read the current editor, guard availability and release every subscription", () => {
    fixture.editor = editor();
    wrapper = mount(WysiwygEditorInner);
    publish(TOPICS.EDITOR_TOGGLE_BOLD);
    expect(fixture.editor.commands.call).toHaveBeenCalledWith(commonmark.toggleStrongCommand.key);
    modal = registerModal({ name: "fixture" });
    publish(TOPICS.EDITOR_TOGGLE_ITALIC);
    expect(fixture.editor.commands.call).toHaveBeenCalledTimes(1);
    modal.dispose(); modal = null;
    const replacement = editor(); fixture.editor = replacement;
    publish(TOPICS.EDITOR_HEADING_3);
    expect(replacement.commands.call).toHaveBeenCalledWith(commonmark.wrapInHeadingCommand.key, { level: 3 });
    wrapper.unmount(); wrapper = null;
    publish(TOPICS.EDITOR_TOGGLE_ITALIC);
    expect(replacement.commands.call).toHaveBeenCalledTimes(1);
  });
  it("wrapper delegates link intent to its toolbar only while actions are available and mounted", () => {
    wrapper = mount(WysiwygEditor, { global: { stubs: {
      WysiwygEditorInner: true,
      WysiwygToolbar: { template: "<div />", setup: () => ({ openLinkPopover: fixture.openLinkPopover }) },
    } } });
    publish(TOPICS.EDITOR_INSERT_LINK); expect(fixture.openLinkPopover).toHaveBeenCalledOnce();
    modal = registerModal({ name: "fixture" });
    publish(TOPICS.EDITOR_INSERT_LINK); expect(fixture.openLinkPopover).toHaveBeenCalledOnce();
    modal.dispose(); modal = null;
    publish(TOPICS.EDITOR_INSERT_LINK); expect(fixture.openLinkPopover).toHaveBeenCalledTimes(2);
    wrapper.unmount(); wrapper = null;
    publish(TOPICS.EDITOR_INSERT_LINK); expect(fixture.openLinkPopover).toHaveBeenCalledTimes(2);
  });
});
