// SPDX-License-Identifier: LGPL-3.0-only

/** Editor keymap injection: builds the mounted editor's keymap from the
 * active keybinding layer. Both builders resolve the layer's
 * binding:"editor" actions and publish them on the editor action channel,
 * and shadow app-level modifier combos so editor-internal defaults
 * (CM6's Mod-Enter insertBlankLine / Mod-I selectParentSyntax, Milkdown's
 * Mod-E inline code) can't double-fire under a rebound key. Bare keys are
 * never shadowed, so typing still works.
 *
 * Latent-conflict fixes baked in here (see the keybinding-layers plan):
 * - Mod-Enter precedence: the layer keymap is placed before the default
 *   keymap, so the layer's editor:save binding wins over insertBlankLine.
 * - Mod-I: the layer's italic binding precedes selectParentSyntax.
 * - Esc ordering: CM6 collapses a multi-cursor selection first and only
 *   publishes editor:exit-edit once the selection is already simple;
 *   Milkdown has no Escape default, so Esc always exits.
 */

import { simplifySelection } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { keymap as pmKeymap } from "prosemirror-keymap";

import { TOPICS } from "../bus/topics.js";
import { dispatchAction } from "./dispatcher.js";
import { ACTIONS } from "./layers.js";
import { isBareKey, platformKey, toCm6 } from "./keys.js";
import { effectiveBindings } from "./store.js";

/** Every editor-resolved key of the active layer, in CM6/PM notation. */
export function editorBoundKeys() {
  const keys = [];
  for (const [action, binding] of Object.entries(effectiveBindings())) {
    const meta = ACTIONS[action];
    if (!meta) continue;
    const keyList = [platformKey(binding)];
    if (binding.alias) keyList.push(platformKey(binding.alias));
    for (const key of keyList) {
      keys.push({ action, key, binding: meta.binding, name: toCm6(key) });
    }
  }
  return keys;
}

/** CM6 keymap extension for the active layer. */
export function cm6LayerKeymap() {
  const bindings = [];
  for (const { action, key, binding, name } of editorBoundKeys()) {
    // Escape is owned by the built-in handler below (collapse-first
    // ordering), so the data binding for exit-edit is not re-added.
    if (action === TOPICS.EDITOR_EXIT_EDIT) continue;
    if (binding === "editor") {
      bindings.push({
        key: name,
        run: () => {
          dispatchAction(action);
          return true;
        },
      });
    } else if (binding === "app" && !isBareKey(key)) {
      bindings.push({ key: name, run: () => true });
    }
  }
  bindings.push({
    key: "Escape",
    run: (view) => {
      if (view.state.selection.ranges.length > 1) {
        simplifySelection(view);
        return true;
      }
      dispatchAction(TOPICS.EDITOR_EXIT_EDIT);
      return true;
    },
  });
  return keymap.of(bindings);
}

/** ProseMirror keymap plugin for the active layer (Milkdown). Prepend it
 * to prosePluginsCtx so it takes precedence over the preset keymaps. */
export function milkdownLayerKeymap() {
  const bindings = {};
  for (const { action, key, binding, name } of editorBoundKeys()) {
    // Escape is owned by the built-in handler below (Milkdown has no
    // Escape default, so Esc always exits).
    if (action === TOPICS.EDITOR_EXIT_EDIT) continue;
    if (binding === "editor") {
      bindings[name] = () => {
        dispatchAction(action);
        return true;
      };
    } else if (binding === "app" && !isBareKey(key)) {
      bindings[name] = () => true;
    }
  }
  bindings["Escape"] = () => {
    dispatchAction(TOPICS.EDITOR_EXIT_EDIT);
    return true;
  };
  return pmKeymap(bindings);
}
