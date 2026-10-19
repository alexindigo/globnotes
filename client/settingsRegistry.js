// SPDX-License-Identifier: LGPL-3.0-only

/** Settings page registry: normalized page IDs (`core:<page>` and
 * `plugin:<id>:<page>`), labels, owner, renderer kind/version and
 * data/commit adapters. Plugin page descriptors come from the vault
 * catalog (manifest settings); registration never depends on opening the
 * editor. Only `declarative-v1` renders in v2 — unknown renderer kinds
 * surface an unsupported-feature diagnostic and are not loaded. */

import { computed } from "vue";

import { getPluginSettings, putPluginSettings } from "./api.js";
import { pluginCatalog } from "./pluginRuntime.js";

const CORE_PAGES = [
  { id: "core:appearance", label: "Appearance", group: "browser", kind: "browser-pref", preference: "appearance", description: "Theme for this browser." },
  { id: "core:editor", label: "Editor", group: "browser", kind: "browser-pref", preference: "editor" },
  { id: "core:keybindings", label: "Keybindings", group: "browser", kind: "browser-pref", preference: "keybindings" },
  { id: "core:diagnostics", label: "Diagnostics", group: "browser", kind: "browser-pref", preference: "diagnostics" },
  { id: "core:plugins", label: "Plugins", group: "vault", kind: "plugins", description: "Turn plugins on or off for this vault." },
  { id: "core:branding", label: "Branding", group: "vault", kind: "branding" },
  { id: "core:access", label: "Access", group: "vault", kind: "access" },
  { id: "core:account", label: "Account", group: "vault", kind: "account" },
];

/** Page kind belongs to its normalized namespace, not its plugin owner name. */
export const isPluginSettingsPage = page => page?.id?.startsWith("plugin:") === true;

/** Reactive page list: core pages + catalog plugin pages. */
export const settingsPages = computed(() => {
  const pages = CORE_PAGES.map((page) => ({
    ...page,
    owner: "core",
    renderer: { kind: "core", version: 1 },
  }));
  for (const plugin of pluginCatalog.value?.plugins ?? []) {
    for (const page of plugin.pages ?? []) {
      pages.push({
        id: `plugin:${plugin.id}:${page.id}`,
        label: page.label,
        group: "plugin",
        kind: page.renderer?.kind === "declarative-v1" ? "plugin-page" : "unsupported",
        owner: plugin.id,
        pageId: page.id,
        renderer: page.renderer,
        descriptor: page,
        blocking: plugin.blocking,
        plugin,
        available: plugin.enabled,
        unsupported: page.renderer?.kind !== "declarative-v1",
      });
    }
  }
  return pages;
});

/** One navigation entry per owner; retained definitions stay reachable as tabs. */
export function settingsNavigation(pages, selected) {
  return [['browser', 'This browser'], ['vault', 'This vault'], ['plugin', 'Plugin settings']].map(([id, label]) => {
    const entries = new Map();
    for (const page of pages) {
      if (page.group !== id) continue;
      const plugin = isPluginSettingsPage(page), key = plugin ? `plugin:${page.owner}` : page.id;
      if (!entries.has(key)) entries.set(key, { id:key, label:plugin ? page.plugin?.name ?? page.owner : page.label, target:page.id, active:false, pages:[] });
      const entry = entries.get(key); entry.pages.push(page); entry.active ||= page.id === selected;
    }
    return { id, label, pages:[...entries.values()] };
  }).filter(group => group.pages.length);
}

export function findPage(pageId) {
  return settingsPages.value.find((page) => page.id === pageId) ?? null;
}

/** Data adapter for a plugin page: effective values + revision, and a
 * validated commit. Throws on unknown pages. */
export async function readPluginPage(owner, pageId) {
  return await getPluginSettings(owner, pageId);
}

export async function commitPluginPage(owner, pageId, values, revision, sourceKey) {
  return await (sourceKey === undefined ? putPluginSettings(owner, pageId, values, revision) : putPluginSettings(owner, pageId, values, revision, sourceKey));
}
