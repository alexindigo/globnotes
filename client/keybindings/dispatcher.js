// SPDX-License-Identifier: LGPL-3.0-only

/** Keybinding dispatcher.
 *
 * Translates raw key events into bus actions per the active keybinding
 * layer. Layers are pure data (layers.js) — nothing here imports an editor.
 * Two input paths feed the same dispatchAction choke point:
 *
 * - App-level keys go through Mousetrap (bound from the active layer).
 * - Editor-internal keys are injected into the mounted editor's keymap
 *   (CM6 compartment / Milkdown keymap), which publish editor:* actions.
 *
 * dispatchAction is the integration point for future input sources
 * (command palette, macros, plugins): they publish the same topics without
 * touching the editors.
 */

import { publish } from "../bus/index.js";

/** Publish an action on the bus. Every input source funnels through here. */
export function dispatchAction(action, payload) {
  publish(action, payload);
}
