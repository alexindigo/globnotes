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

import { ref, watch } from "vue";

import { getPlugins } from "./api.js";
import { pluginCatalog } from "./pluginRuntime.js";

const pathPrefix =
  document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

/** Bumped whenever a dual-mode plugin's enabled state toggles, so the
 * WYSIWYG editor remounts and re-runs loadClientPlugins (the same keyed
 * remount pattern the keybinding layer switch uses). */
export const clientPluginEpoch = ref(0);

// The catalog includes disabled/editor-only inventory. Only a change to
// actual editor participation recreates Milkdown; app commands, settings and
// permission projections cannot remount an unrelated active buffer.
let participation = null;
watch(pluginCatalog, (catalog) => {
  if (!catalog) return;
  const next = JSON.stringify(catalog.plugins
    .filter(plugin => plugin.client && plugin.enabled)
    .map(plugin => plugin.id).sort());
  if (participation !== null && participation !== next) clientPluginEpoch.value++;
  participation = next;
}, { immediate: true });

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
  // This compatibility endpoint already returns vault-enabled plugins.
  // Retained per-browser switches are preferences, not activation authority.
  const enabled = (plugins ?? []).filter((p) => p.client);
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
