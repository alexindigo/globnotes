// Layer matrix correctness: every layer's bindings must reference known
// actions, carry per-platform keys, and include the cross-layer constants.
import { describe, expect, it } from "vitest";

import { TOPICS } from "../bus/topics.js";
import {
  ACTIONS,
  CUSTOM_LAYER_ID,
  LAYERS,
  LAYER_ORDER,
  LEGACY_LAYER_ID,
} from "../keybindings/layers.js";
import { isBareKey, toCm6, toMousetrap } from "../keybindings/keys.js";

describe("keybinding layer matrix", () => {
  it("resolves every id in LAYER_ORDER (Custom resolved by the store)", () => {
    for (const id of LAYER_ORDER) {
      if (id === CUSTOM_LAYER_ID) continue;
      expect(LAYERS[id], `layer ${id}`).toBeTruthy();
    }
  });

  it("only binds actions that exist in ACTIONS", () => {
    for (const layer of Object.values(LAYERS)) {
      for (const [action, binding] of Object.entries(layer.bindings)) {
        expect(ACTIONS[action], `${layer.id} binds ${action}`).toBeTruthy();
        expect(typeof binding.mac, `${action} mac`).toBe("string");
        expect(typeof binding.other, `${action} other`).toBe("string");
        if (binding.alias) {
          expect(typeof binding.alias.mac).toBe("string");
          expect(typeof binding.alias.other).toBe("string");
        }
        if (binding.context) {
          expect(binding.context).toBe("selection");
          expect(typeof binding.fallback).toBe("string");
        }
      }
    }
  });

  it("every action's binding mechanism is app or editor", () => {
    for (const [action, meta] of Object.entries(ACTIONS)) {
      expect(
        ["app", "editor"],
        `${action} binding mechanism`,
      ).toContain(meta.binding);
      expect(typeof meta.label).toBe("string");
    }
  });

  it("every layer keeps the cross-layer constants", () => {
    for (const layer of Object.values(LAYERS)) {
      expect(layer.bindings[TOPICS.APP_NEW_NOTE]).toEqual({
        mac: "Ctrl+Alt+N",
        other: "Ctrl+Alt+N",
      });
      expect(layer.bindings[TOPICS.APP_GO_HOME]).toEqual({
        mac: "Ctrl+Alt+H",
        other: "Ctrl+Alt+H",
      });
      expect(layer.bindings[TOPICS.EDITOR_EXIT_EDIT]).toEqual({
        mac: "Escape",
        other: "Escape",
      });
    }
  });

  it("non-legacy layers save with Mod+S and keep Ctrl/Cmd+Enter as alias", () => {
    for (const id of ["obsidian", "notion", "typora", "vscode-lite"]) {
      const save = LAYERS[id].bindings[TOPICS.EDITOR_SAVE];
      expect(save, `${id} Mod+S`).toEqual({
        mac: "Cmd+S",
        other: "Ctrl+S",
        alias: { mac: "Cmd+Enter", other: "Ctrl+Enter" },
      });
    }
    // Legacy is Enter-only.
    expect(LAYERS[LEGACY_LAYER_ID].bindings[TOPICS.EDITOR_SAVE]).toEqual({
      mac: "Cmd+Enter",
      other: "Ctrl+Enter",
    });
  });

  it("the legacy layer binds E to toggle edit", () => {
    expect(LAYERS[LEGACY_LAYER_ID].bindings[TOPICS.EDITOR_TOGGLE_EDIT]).toEqual({
      mac: "E",
      other: "E",
    });
  });

  it("the legacy layer restores / for the quick switcher", () => {
    // The regression fix: the rewrite dropped the Flatnotes/upstream
    // quick-switcher key.
    expect(LAYERS[LEGACY_LAYER_ID].bindings[TOPICS.APP_OPEN_SWITCHER]).toEqual({
      mac: "/",
      other: "/",
    });
    // It is a bare key, so the dispatcher binds it (not globally) and it
    // never fires while typing.
    expect(isBareKey(LAYERS[LEGACY_LAYER_ID].bindings[TOPICS.APP_OPEN_SWITCHER].other)).toBe(true);
  });
});

describe("key notation converters", () => {
  it("lowercases for Mousetrap", () => {
    expect(toMousetrap("Cmd+Shift+K")).toBe("cmd+shift+k");
    expect(toMousetrap("Ctrl+Alt+N")).toBe("ctrl+alt+n");
    expect(toMousetrap("Escape")).toBe("escape");
  });

  it("maps Cmd to CM6 Mod and keeps literal Ctrl", () => {
    expect(toCm6("Cmd+S")).toBe("Mod-s");
    expect(toCm6("Ctrl+S")).toBe("Ctrl-s");
    expect(toCm6("Cmd+Alt+1")).toBe("Mod-Alt-1");
    expect(toCm6("Shift+Tab")).toBe("Shift-Tab");
    expect(toCm6("Escape")).toBe("Escape");
    expect(toCm6("Cmd+Enter")).toBe("Mod-Enter");
    // Shift+letter stays uppercase: the libraries build lookup keys from
    // event.key, which browsers report uppercase for shift+letter.
    expect(toCm6("Ctrl+Shift+K")).toBe("Ctrl-Shift-K");
    expect(toCm6("Alt+C")).toBe("Alt-c");
  });

  it("detects bare keys", () => {
    expect(isBareKey("E")).toBe(true);
    expect(isBareKey("Escape")).toBe(true);
    expect(isBareKey("Ctrl+K")).toBe(false);
  });
});
