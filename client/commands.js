// SPDX-License-Identifier: LGPL-3.0-only

/** Reactive command registry: ONE registry for built-ins, palette,
 * keybinding remapping, buttons and plugin SDK invocation. Built-in
 * commands are seeded from ACTIONS metadata and dispatch through the same
 * bus topics as before. Plugin commands are namespaced
 * `plugin:<plugin-id>:<command-id>`; a plugin can never overwrite a
 * built-in or another plugin's command, and disabled owners disappear
 * from availability while dormant user shortcut mappings are retained. */

import { computed, shallowRef } from "vue";

import { invokePluginCommand } from "./api.js";
import { dispatchAction } from "./keybindings/dispatcher.js";
import { ACTIONS } from "./keybindings/layers.js";
import { effectiveBindings } from "./keybindings/store.js";
import { platformKey } from "./keybindings/keys.js";
import { isActionAvailable } from "./modalState.js";

const pluginCommands = shallowRef(new Map());

function builtinEntries() {
  return Object.entries(ACTIONS).map(([topic, meta]) => ({
    id: topic,
    label: meta.label,
    group: meta.group,
    target: "app",
    owner: "core",
  }));
}

/** Registry list for the palette/keybindings UIs. */
export const commandRegistry = computed(() => [
  ...builtinEntries(),
  ...[...pluginCommands.value.values()].map((entry) => ({
    id: entry.fullId,
    label: entry.definition.label,
    group: entry.definition.group ?? "Plugins",
    target: entry.definition.target,
    owner: entry.pluginId,
  })),
]);

export function commandHint(id) {
  const binding = effectiveBindings()[id];
  return binding ? platformKey(binding) : "";
}

/** Register a plugin command. `run` is required for browser-target
 * commands; server-target commands dispatch through the authenticated
 * plugin-host POST and resolve with the actual result. */
export function registerPluginCommand(pluginId, definition, run) {
  if (definition.target === "server" && typeof run !== "function") {
    run = null;
  }
  if (definition.target !== "server" && typeof run !== "function") {
    throw new Error("browser/editor plugin commands require a handler");
  }
  const fullId = `plugin:${pluginId}:${definition.id}`;
  if (ACTIONS[fullId] || pluginCommands.value.has(fullId)) {
    throw new Error(`duplicate command id '${fullId}'`);
  }
  const next = new Map(pluginCommands.value);
  const entry = { fullId, pluginId, definition, run };
  next.set(fullId, entry);
  pluginCommands.value = next;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (pluginCommands.value.get(fullId) !== entry) return;
    const rest = new Map(pluginCommands.value);
    rest.delete(fullId);
    pluginCommands.value = rest;
  };
}

/** Remove every registration owned by a plugin (disable/unload). Dormant
 * user shortcut mappings in the keybinding store are NOT touched. */
export function removeCommandOwner(pluginId) {
  const rest = new Map(
    [...pluginCommands.value].filter(([, entry]) => entry.pluginId !== pluginId),
  );
  pluginCommands.value = rest;
}

/** Run a command by id. Built-ins dispatch their bus topic (admission,
 * not completion); server commands resolve with the actual result. */
export async function runCommand(id, payload = {}) {
  if (!isActionAvailable(id)) return { admitted: false };
  if (ACTIONS[id]) {
    return { admitted: dispatchAction(id, payload) !== false };
  }
  const entry = pluginCommands.value.get(id);
  if (!entry) throw new Error(`unknown command '${id}'`);
  if (entry.definition.target === "server") {
    const result = await invokePluginCommand(
      entry.pluginId,
      entry.definition.id,
      payload,
    );
    return { result };
  }
  const result = await entry.run(payload);
  return { result };
}

export function hasCommand(id) {
  return !!ACTIONS[id] || pluginCommands.value.has(id);
}
