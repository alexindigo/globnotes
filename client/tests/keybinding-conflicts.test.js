// Latent-conflict fixes: CM6 Mod-Enter precedence, Mod-I vs italic, and
// the Esc ordering (collapse first, exit second). Drives real keydown
// events through a real EditorView with the layer keymap installed.
import { describe, expect, it } from "vitest";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { subscribe, TOPICS } from "../bus/index.js";
import {
  cm6LayerKeymap,
  editorBoundKeys,
  milkdownLayerKeymap,
} from "../keybindings/editor-keymap.js";
import { setLayer } from "../keybindings/store.js";

function makeView(doc = "one two\nthree") {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      // Multi-cursor must be opted into; enabled so the Escape-ordering
      // test can exercise a multi-cursor selection.
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        history(),
        cm6LayerKeymap(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
      ],
    }),
  });
}

function keydown(view, key, options = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  for (const prop of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
    if (options[prop]) Object.defineProperty(event, prop, { get: () => true });
  }
  view.contentDOM.dispatchEvent(event);
}

describe("editor keymap latent conflicts", () => {
  it("Mod-Enter runs save instead of insertBlankLine", () => {
    setLayer("legacy");
    const events = [];
    const unsub = subscribe(TOPICS.EDITOR_SAVE, () => events.push(true));
    const view = makeView("one two\nthree");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    keydown(view, "Enter", { ctrlKey: true });
    unsub();
    // The save action fired and the default insertBlankLine never ran.
    expect(events).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("one two\nthree");
  });

  it("the layer's Mod-I binding wins over selectParentSyntax", () => {
    setLayer("vscode-lite");
    const events = [];
    const unsub = subscribe(TOPICS.EDITOR_TOGGLE_ITALIC, () =>
      events.push(true));
    const view = makeView("plain `code` here");
    view.dispatch({ selection: EditorSelection.cursor(9) });
    keydown(view, "i", { ctrlKey: true });
    unsub();
    expect(events).toHaveLength(1);
    // selectParentSyntax would have selected the inline code node.
    expect(view.state.selection.main.from).toBe(9);
  });

  it("Escape collapses a multi-cursor selection before exiting", () => {
    setLayer("legacy");
    const exits = [];
    const unsub = subscribe(TOPICS.EDITOR_EXIT_EDIT, () => exits.push(true));
    const view = makeView("one two\nthree");
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(3),
      ]),
    });
    keydown(view, "Escape");
    // First press: cursors collapsed, no exit published.
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(exits).toHaveLength(0);
    // Second press: selection already simple, exit-edit fires.
    keydown(view, "Escape");
    expect(exits).toHaveLength(1);
    unsub();
  });

  it("Escape exits when the selection is already simple", () => {
    setLayer("legacy");
    const exits = [];
    const unsub = subscribe(TOPICS.EDITOR_EXIT_EDIT, () => exits.push(true));
    const view = makeView("one two\nthree");
    keydown(view, "Escape");
    expect(exits).toHaveLength(1);
    unsub();
  });

  it("resolves editor-bound keys per layer (save alias, formatting)", () => {
    setLayer("obsidian");
    const keys = editorBoundKeys();
    const byName = (name) => keys.filter((k) => k.name === name);
    // Mod+S primary with Mod+Enter alias, headings, link. (jsdom reports
    // a non-mac platform, so the "other" platform keys resolve.)
    expect(byName("Ctrl-s").map((k) => k.action)).toEqual(["editor:save"]);
    expect(byName("Ctrl-Enter").map((k) => k.action)).toContain("editor:save");
    expect(byName("Ctrl-Alt-1").map((k) => k.action)).toEqual([
      "editor:heading-1",
    ]);
    // App-rebound combos are shadowed in the editor keymap.
    expect(byName("Ctrl-e").map((k) => k.binding)).toEqual(["app"]);

    setLayer("vscode-lite");
    const vsKeys = editorBoundKeys().filter((k) => k.binding === "editor");
    expect(vsKeys.map((k) => `${k.name}=${k.action}`)).toContain(
      "Ctrl-b=editor:toggle-bold",
    );
    expect(vsKeys.map((k) => `${k.name}=${k.action}`)).toContain(
      "Ctrl-i=editor:toggle-italic",
    );
  });

  it("milkdownLayerKeymap returns a precedence-ready PM plugin", () => {
    setLayer("typora");
    const plugin = milkdownLayerKeymap();
    expect(plugin.props.handleKeyDown).toBeTypeOf("function");
  });
});
