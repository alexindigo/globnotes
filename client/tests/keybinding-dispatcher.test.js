// Dispatcher: Mousetrap-bound app-level keys publish bus actions per the
// active layer, including the smart selection-context resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribe, TOPICS } from "../bus/index.js";
import {
  dispatchAction,
  initDispatcher,
  rebindDispatcher,
  resolveAction,
} from "../keybindings/dispatcher.js";

// Mousetrap reads e.which (not e.key); jsdom's KeyboardEvent ignores
// keyCode in its init dict, so define it post-construction.
const MODIFIER_PROPS = ["ctrlKey", "metaKey", "shiftKey", "altKey"];

function keyEvent(type, which, options = {}) {
  const event = new KeyboardEvent(type, {
    key: options.key ?? String.fromCharCode(which),
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "which", { get: () => which });
  Object.defineProperty(event, "keyCode", { get: () => which });
  for (const prop of MODIFIER_PROPS) {
    if (options[prop]) {
      Object.defineProperty(event, prop, { get: () => true });
    }
  }
  return event;
}

function pressKey(which, options = {}) {
  // Bare letters bind to keypress, modifier combos to keydown (Mousetrap).
  const hasModifiers = MODIFIER_PROPS.some((p) => options[p]);
  document.dispatchEvent(
    keyEvent(hasModifiers ? "keydown" : "keypress", which, options),
  );
}

describe("dispatcher", () => {
  let unsubs;
  function collect(action) {
    const events = [];
    unsubs.push(subscribe(action, (payload) => events.push(payload ?? true)));
    return events;
  }

  beforeEach(async () => {
    localStorage.clear();
    unsubs = [];
    initDispatcher();
    // Restore the default layer through the store (localStorage is only
    // read at module load; setLayer drives the rebind subscription).
    const { setLayer } = await import("../keybindings/store.js");
    setLayer("legacy");
  });

  afterEach(() => {
    unsubs.forEach((fn) => fn());
  });

  it("cross-layer constants publish app actions", () => {
    const newNote = collect(TOPICS.APP_NEW_NOTE);
    const goHome = collect(TOPICS.APP_GO_HOME);
    pressKey(78, { ctrlKey: true, altKey: true });
    pressKey(72, { ctrlKey: true, altKey: true });
    expect(newNote).toHaveLength(1);
    expect(goHome).toHaveLength(1);
  });

  it("the legacy layer binds E to toggle edit", () => {
    const toggle = collect(TOPICS.EDITOR_TOGGLE_EDIT);
    pressKey(69);
    expect(toggle).toHaveLength(1);
  });

  it("rebinds when the layer changes", async () => {
    const switcher = collect(TOPICS.APP_OPEN_SWITCHER);
    const toggle = collect(TOPICS.EDITOR_TOGGLE_EDIT);
    // Obsidian layer: Ctrl+E toggles edit, Ctrl+O opens the switcher.
    const { setLayer } = await import("../keybindings/store.js");
    setLayer("obsidian");
    pressKey(69, { ctrlKey: true });
    expect(toggle).toHaveLength(1);
    pressKey(79, { ctrlKey: true });
    expect(switcher).toHaveLength(1);
    // Bare E is no longer bound in obsidian — no toggle fires.
    pressKey(69);
    expect(toggle).toHaveLength(1);
  });

  it("bare E does nothing in layers that do not bind it", async () => {
    const { setLayer } = await import("../keybindings/store.js");
    setLayer("obsidian");
    const toggle = collect(TOPICS.EDITOR_TOGGLE_EDIT);
    pressKey(69);
    expect(toggle).toHaveLength(0);
  });

  it("notion Mod+K opens the switcher with a collapsed selection", async () => {
    const { setLayer } = await import("../keybindings/store.js");
    setLayer("notion");
    const switcher = collect(TOPICS.APP_OPEN_SWITCHER);
    const insertLink = collect(TOPICS.EDITOR_INSERT_LINK);
    pressKey(75, { ctrlKey: true });
    expect(switcher).toHaveLength(1);
    expect(insertLink).toHaveLength(0);
  });

  it("notion Mod+K inserts a link with a non-collapsed selection", async () => {
    const { setLayer } = await import("../keybindings/store.js");
    setLayer("notion");
    const switcher = collect(TOPICS.APP_OPEN_SWITCHER);
    const insertLink = collect(TOPICS.EDITOR_INSERT_LINK);
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false });
    try {
      pressKey(75, { ctrlKey: true });
    } finally {
      vi.restoreAllMocks();
    }
    expect(insertLink).toHaveLength(1);
    expect(switcher).toHaveLength(0);
  });

  it("editor-internal actions are not Mousetrap-bound", async () => {
    const { setLayer } = await import("../keybindings/store.js");
    setLayer("vscode-lite");
    const bold = collect(TOPICS.EDITOR_TOGGLE_BOLD);
    pressKey(66, { ctrlKey: true });
    // Formatting goes through the editor keymap, not the dispatcher.
    expect(bold).toHaveLength(0);
  });

  it("resolveAction falls back only for selection-context bindings", () => {
    const fallback = { context: "selection", fallback: "app:open-switcher" };
    expect(resolveAction(fallback, "editor:insert-link", { isCollapsed: true }))
      .toBe("app:open-switcher");
    expect(resolveAction(fallback, "editor:insert-link", { isCollapsed: false }))
      .toBe("editor:insert-link");
    expect(resolveAction({}, "editor:insert-link", { isCollapsed: true }))
      .toBe("editor:insert-link");
  });

  it("dispatchAction publishes on the bus", () => {
    const events = collect(TOPICS.APP_OPEN_PALETTE);
    dispatchAction(TOPICS.APP_OPEN_PALETTE);
    expect(events).toHaveLength(1);
  });
});
