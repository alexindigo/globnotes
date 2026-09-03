// SPDX-License-Identifier: LGPL-3.0-only

/** Keybinding dispatcher.
 *
 * Translates raw key events into bus actions per the active keybinding
 * layer. Layers are pure data (layers.js) — nothing here imports an
 * editor. Two input paths feed the same dispatchAction choke point:
 *
 * - App-level actions ("binding: app" in ACTIONS) are bound here via
 *   Mousetrap from the active layer, rebound on every layer change.
 *   Modifier combos bind globally so they work inside the editors;
 *   bare keys bind normally so they never fire while typing.
 * - Editor-internal actions ("binding: editor") are injected into the
 *   mounted editor's keymap (CM6 compartment / Milkdown keymap), which
 *   publish editor:* actions on the bus.
 *
 * dispatchAction is the integration point for future input sources
 * (command palette, macros, plugins): they publish the same topics
 * without touching the editors.
 */

import Mousetrap from "mousetrap";
import "mousetrap/plugins/global-bind/mousetrap-global-bind";

import { publish, subscribe, TOPICS } from "../bus/index.js";
import { ACTIONS } from "./layers.js";
import { isBareKey, platformKey, toMousetrap } from "./keys.js";
import { effectiveBindings } from "./store.js";

/** Publish an action on the bus. Every input source funnels through here. */
export function dispatchAction(action, payload) {
  publish(action, payload);
}

/** Resolve one keydown to the action it publishes. Smart bindings
 * (context: "selection") fire the primary action only when the editor
 * selection is non-empty, else the fallback — Notion's Mod+K lives here:
 * link with a selection, switcher without. */
export function resolveAction(binding, action, selection) {
  if (binding?.context === "selection" && binding.fallback) {
    const sel = selection ?? window.getSelection();
    if (!sel || sel.isCollapsed) return binding.fallback;
  }
  return action;
}

function mousetrapHandler(action, binding) {
  return () => {
    dispatchAction(resolveAction(binding, action));
    return false;
  };
}

let initialized = false;

/** Bind the active layer's app-level actions via Mousetrap and rebind on
 * every layer change. Idempotent; called once from App.vue. */
export function initDispatcher() {
  if (initialized) return;
  initialized = true;
  rebindDispatcher();
  subscribe(TOPICS.KEYBINDINGS_CHANGE, rebindDispatcher);
}

/** Rebind all app-level actions from the currently active layer. */
export function rebindDispatcher() {
  Mousetrap.reset();
  const bindings = effectiveBindings();
  for (const [action, binding] of Object.entries(bindings)) {
    const meta = ACTIONS[action];
    if (!meta || meta.binding !== "app") continue;
    const keys = [platformKey(binding)];
    if (binding.alias) keys.push(platformKey(binding.alias));
    for (const key of keys) {
      const sequence = toMousetrap(key);
      if (isBareKey(key)) {
        Mousetrap.bind(sequence, mousetrapHandler(action, binding));
      } else {
        Mousetrap.bindGlobal(sequence, mousetrapHandler(action, binding));
      }
    }
  }
}
