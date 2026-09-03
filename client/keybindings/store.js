// SPDX-License-Identifier: LGPL-3.0-only

/** Keybinding layer store. Same pattern as themes.js: module-level ref
 * seeded from localStorage, setter persists and publishes a bus topic.
 *
 * - Active layer id: localStorage "globnotes-keybindings".
 * - Custom-layer overrides: localStorage "globnotes-keybindings-custom"
 *   (JSON map action → binding). The Custom layer's effective bindings
 *   are the base layer (Legacy) merged under the overrides.
 */

import { ref } from "vue";
import { publish, TOPICS } from "../bus/index.js";
import {
  CUSTOM_BASE_LAYER_ID,
  CUSTOM_LAYER_ID,
  LAYERS,
  LEGACY_LAYER_ID,
} from "./layers.js";

const LAYER_STORAGE_KEY = "globnotes-keybindings";
const CUSTOM_STORAGE_KEY = "globnotes-keybindings-custom";

function loadLayerId() {
  const id = localStorage.getItem(LAYER_STORAGE_KEY);
  if (id === CUSTOM_LAYER_ID) return id;
  return LAYERS[id] ? id : LEGACY_LAYER_ID;
}

function loadOverrides() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CUSTOM_STORAGE_KEY) ?? "{}",
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const currentLayerId = ref(loadLayerId());

const customOverrides = ref(loadOverrides());

/** Layer meta (id/label/description) for the active layer. */
export function currentLayer() {
  return LAYERS[currentLayerId.value] ?? LAYERS[LEGACY_LAYER_ID];
}

/** Effective bindings for the active layer. For Custom, the base layer's
 * bindings merged under the persisted per-binding overrides. */
export function effectiveBindings() {
  if (currentLayerId.value !== CUSTOM_LAYER_ID) {
    return { ...LAYERS[currentLayerId.value].bindings };
  }
  return { ...LAYERS[CUSTOM_BASE_LAYER_ID].bindings, ...customOverrides.value };
}

/** Per-binding overrides currently stored for the Custom layer. */
export function customOverridesMap() {
  return { ...customOverrides.value };
}

export function isCustomLayer() {
  return currentLayerId.value === CUSTOM_LAYER_ID;
}

export function setLayer(id) {
  if (!LAYERS[id] && id !== CUSTOM_LAYER_ID) return;
  currentLayerId.value = id;
  localStorage.setItem(LAYER_STORAGE_KEY, id);
  publish(TOPICS.KEYBINDINGS_CHANGE, { id });
}

/** Remap one action in the Custom layer ({ mac, other }, or an extended
 * binding with alias/context) and persist. Only meaningful while Custom
 * is the active layer; ignored otherwise. */
export function setCustomBinding(action, binding) {
  if (!isCustomLayer()) return;
  customOverrides.value = { ...customOverrides.value, [action]: binding };
  localStorage.setItem(
    CUSTOM_STORAGE_KEY,
    JSON.stringify(customOverrides.value),
  );
  publish(TOPICS.KEYBINDINGS_CHANGE, { id: CUSTOM_LAYER_ID });
}

/** Remove a Custom-layer override, falling that binding back to the base. */
export function removeCustomBinding(action) {
  if (!isCustomLayer() || !(action in customOverrides.value)) return;
  const next = { ...customOverrides.value };
  delete next[action];
  customOverrides.value = next;
  localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(next));
  publish(TOPICS.KEYBINDINGS_CHANGE, { id: CUSTOM_LAYER_ID });
}
