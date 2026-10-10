// SPDX-License-Identifier: LGPL-3.0-only

/** Settings page registry: normalized page IDs (`core:<page>` and
 * `plugin:<id>:<page>`), labels, owner, renderer kind/version and
 * data/commit adapters. Plugin page descriptors come from the vault
 * catalog (manifest settings); registration never depends on opening the
 * editor. Only `declarative-v1` renders in v2 — unknown renderer kinds
 * surface an unsupported-feature diagnostic and are not loaded. */

import { computed, ref } from "vue";

import { getPluginSettings, putPluginSettings } from "./api.js";
import { pluginCatalog } from "./pluginRuntime.js";

const CORE_PAGES = [
  { id: "core:appearance", label: "Appearance", group: "Settings" },
  { id: "core:keybindings", label: "Keybindings", group: "Settings" },
  { id: "core:plugins", label: "Plugins", group: "Settings" },
  { id: "core:branding", label: "Branding", group: "Settings" },
  { id: "core:access", label: "Access", group: "Settings" },
  { id: "core:editor", label: "Editor", group: "Settings" },
  { id: "core:diagnostics", label: "Diagnostics", group: "Settings" },
  { id: "core:account", label: "Account", group: "Settings" },
];

/** Framework review IDs cannot collide with plugin-declared page IDs. */
export const permissionPageId = id => `core:plugin-permissions:${id}`;

/** Reactive page list: core pages + catalog plugin pages. */
export const settingsPages = computed(() => {
  const pages = CORE_PAGES.map((page) => ({
    ...page,
    owner: "core",
    renderer: { kind: "core", version: 1 },
  }));
  for (const plugin of pluginCatalog.value?.plugins ?? []) {
    pages.push({ id: permissionPageId(plugin.id), label: "Server permissions", group: plugin.name ?? plugin.id,
      owner: "core", renderer: { kind: "core", version: 1 }, permissionPluginId: plugin.id,
      plugin, available: true, unsupported: false });
    for (const page of plugin.pages ?? []) {
      pages.push({
        id: `plugin:${plugin.id}:${page.id}`,
        label: page.label,
        group: plugin.name ?? plugin.id,
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
