// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Client plugin loader — the dual-mode contract's client half. Fetches
 * the plugin list, then dynamic-imports each dual-mode plugin's client
 * module from the server (served fresh from disk, mirrors plugins.css).
 * A module default-exports an array of Milkdown plugin factories
 * ($remark/$node/$view from @milkdown/utils; bare imports resolve via the
 * app's import map). Disabled plugins are skipped so the core frontmatter
 * fallback view shows instead — the same switches drive the server render.
 */

import { ref } from "vue";

import { getPlugins } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { isPluginEnabled } from "./pluginSettings.js";

const pathPrefix =
  document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

/** Bumped whenever a dual-mode plugin's enabled state toggles, so the
 * WYSIWYG editor remounts and re-runs loadClientPlugins (the same keyed
 * remount pattern the keybinding layer switch uses). */
export const clientPluginEpoch = ref(0);

/** Last-known dual-mode plugin ids — a toggle for anything else never
 * touches the editor. */
let clientPluginIds = new Set();

subscribe(TOPICS.PLUGIN_TOGGLE, ({ id }) => {
  if (clientPluginIds.has(id)) clientPluginEpoch.value++;
});

/** Milkdown plugin factories from every enabled dual-mode plugin. Never
 * throws: a broken plugin logs and is skipped — it must never take the
 * editor down (same rule as the server pipeline). */
export async function loadClientPlugins() {
  let plugins;
  try {
    plugins = await getPlugins();
  } catch (e) {
    console.error("plugin list fetch failed", e);
    return [];
  }
  const enabled = (plugins ?? []).filter(
    (p) => p.client && isPluginEnabled(p.id),
  );
  // Every dual-mode id (enabled or not) — enabling a currently-disabled
  // client plugin must also bump the epoch.
  clientPluginIds = new Set((plugins ?? []).filter((p) => p.client).map((p) => p.id));
  const lists = await Promise.all(
    enabled.map(async (p) => {
      try {
        const url = `${pathPrefix}/_/plugins/${encodeURIComponent(p.id)}/client.js`;
        const mod = await import(/* @vite-ignore */ url);
        return Array.isArray(mod.default) ? mod.default : [];
      } catch (e) {
        console.error(`plugin '${p.id}' client module failed to load`, e);
        return [];
      }
    }),
  );
  return lists.flat();
}
