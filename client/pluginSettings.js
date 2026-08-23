// Plugin enable/disable state — localStorage, per browser. The server
// stays stateless: ServerViewer passes the disabled ids with each render
// request.

import { useGlobalStore } from "./globalStore.js";

const AUTO_KEY = "autoEnablePlugins";
const SWITCHES_KEY = "pluginSwitches";

export function loadAutoEnable() {
  const raw = localStorage.getItem(AUTO_KEY);
  if (raw !== null) {
    return raw === "true";
  }
  // Default from the server config (GLOBNOTES_AUTO_ENABLE_PLUGINS).
  return useGlobalStore().config.autoEnablePlugins ?? true;
}

export function saveAutoEnable(value) {
  localStorage.setItem(AUTO_KEY, String(value));
}

/** Per-plugin tri-state: true = on, false = off, missing = follow the
 * auto-enable default. */
export function loadSwitches() {
  try {
    return JSON.parse(localStorage.getItem(SWITCHES_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSwitch(id, value) {
  const switches = loadSwitches();
  switches[id] = value;
  localStorage.setItem(SWITCHES_KEY, JSON.stringify(switches));
}

export function isPluginEnabled(id) {
  return loadSwitches()[id] ?? loadAutoEnable();
}

/** ids of every currently-disabled plugin, for the render request. */
export function disabledPluginIds(plugins) {
  return plugins.filter((p) => !isPluginEnabled(p.id)).map((p) => p.id);
}
