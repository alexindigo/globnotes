// SPDX-License-Identifier: LGPL-3.0-only
/** Immutable host-only configuration; no Worker environment/permission lookup. */
import {
  type JsonValues,
  jsonValues,
  PLUGIN_LIMITS,
  PluginContractError,
  pluginId,
  type SettingsPage,
} from "./contracts.ts";
import { projectPageValues, validateFieldValue } from "./settings.ts";
import { sourceDigest } from "./installed_source.ts";
export {
  installedSettingsFingerprint,
  sourceDigest,
} from "./installed_source.ts";

export interface SettingProvenance {
  source: "environment" | "toml" | "vault" | "default";
  readonly: boolean;
}
export interface SettingsContext {
  readonly codeFingerprint: string;
  key(revision: number): string;
  assertCurrent(): void;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => [key, canonical(item)]),
    );
  }
  return value;
}
export function effectiveSourceKey(
  id: string,
  codeFingerprint: string,
  settingsRevision: number,
  overrideFingerprint?: string,
): string {
  return sourceDigest(
    JSON.stringify({
      pluginId: id,
      codeFingerprint,
      settingsRevision,
      ...(overrideFingerprint === undefined ? {} : { overrideFingerprint }),
    }),
  );
}
function invalid(): never {
  throw new PluginContractError(
    422,
    "invalid_plugin_settings_environment",
    "plugins.settings contains malformed, unknown or invalid addressed settings; values are not logged.",
  );
}
export class PluginSettingsEnvironment {
  readonly #values: JsonValues;
  readonly #source: "environment" | "toml";
  constructor(
    raw?: string,
    source: "environment" | "toml" = "environment",
  ) {
    this.#source = source;
    try {
      if (
        raw !== undefined &&
        (raw.length > PLUGIN_LIMITS.controlBytes ||
          new TextEncoder().encode(raw).length > PLUGIN_LIMITS.controlBytes)
      ) invalid();
      this.#values = raw === undefined ? {} : jsonValues(JSON.parse(raw));
      for (const id of Object.keys(this.#values)) pluginId(id);
    } catch {
      invalid();
    }
  }
  validateInventory(ids: readonly string[]): void {
    if (Object.keys(this.#values).some((id) => !ids.includes(id))) invalid();
  }
  fingerprint(id: string): string | undefined {
    return Object.hasOwn(this.#values, id)
      ? sourceDigest(JSON.stringify(canonical(this.#values[id])))
      : undefined;
  }
  pages(id: string, pages: SettingsPage[]): Record<string, JsonValues> {
    try {
      const selected = Object.hasOwn(this.#values, id)
        ? jsonValues(this.#values[id])
        : {};
      const result: Record<string, JsonValues> = {};
      for (const [pageId, raw] of Object.entries(selected)) {
        const page = pages.find((page) => page.id === pageId);
        if (!page) invalid();
        const values = jsonValues(raw);
        for (const [key, value] of Object.entries(values)) {
          const field = page.fields.find((field) => field.key === key);
          if (!field) invalid();
          validateFieldValue(field, value);
        }
        result[pageId] = values;
      }
      return result;
    } catch {
      invalid();
    }
  }
  project(id: string, page: SettingsPage, saved: unknown, pages = [page]) {
    const stored = jsonValues(saved),
      fallback = projectPageValues(page, stored);
    const pins = this.pages(id, pages)[page.id] ?? {};
    const fields: Record<string, SettingProvenance> = {};
    for (const field of page.fields) {
      const pinned = Object.hasOwn(pins, field.key);
      fields[field.key] = {
        source: pinned
          ? this.#source
          : Object.hasOwn(stored, field.key)
          ? "vault"
          : "default",
        readonly: pinned,
      };
    }
    return { values: { ...fallback, ...pins }, fields };
  }
}
