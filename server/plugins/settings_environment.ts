// SPDX-License-Identifier: LGPL-3.0-only
/** Immutable host-only configuration; no Worker environment/permission lookup. */
import { createHash } from "node:crypto";
import * as path from "@std/path";
import {
  type JsonValues,
  jsonValues,
  PLUGIN_LIMITS,
  PluginContractError,
  pluginId,
  type SettingsPage,
} from "./contracts.ts";
import { projectPageValues, validateFieldValue } from "./settings.ts";
import { pluginCodePath } from "./manifest.ts";

export interface SettingProvenance {
  source: "environment" | "vault" | "default";
  readonly: boolean;
}
export interface SettingsContext {
  readonly codeFingerprint: string;
  key(revision: number): string;
  assertCurrent(): void;
}
export const sourceDigest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
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
    "GLOBNOTES_PLUGIN_SETTINGS contains malformed, unknown or invalid addressed settings; values are not logged.",
  );
}
export class PluginSettingsEnvironment {
  readonly #values: JsonValues;
  constructor(raw?: string) {
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
          ? "environment"
          : Object.hasOwn(stored, field.key)
          ? "vault"
          : "default",
        readonly: pinned,
      };
    }
    return { values: { ...fallback, ...pins }, fields };
  }
}
/** Identical byte/topology digest to the asynchronous installed-code producer;
 * synchronous comparison permits a final effect/disclosure fence without await. */
export function installedSettingsFingerprint(dir: string): string {
  const root = Deno.realPathSync(dir),
    rows: { path: string; hash: string; target?: string }[] = [],
    visited = new Set<string>();
  function visit(relative = "") {
    const directory = relative ? pluginCodePath(root, relative) : root;
    if (visited.has(directory)) {
      throw new PluginContractError(
        409,
        "permission_source_invalid",
        "plugin code contains a directory cycle",
      );
    }
    visited.add(directory);
    for (
      const entry of [...Deno.readDirSync(directory)].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    ) {
      const name = relative ? `${relative}/${entry.name}` : entry.name,
        file = pluginCodePath(root, name),
        info = Deno.statSync(file);
      if (info.isDirectory) visit(name);
      else if (info.isFile) {
        rows.push({
          path: name,
          hash: sourceDigest(Deno.readFileSync(file)),
          ...(entry.isSymlink
            ? { target: Deno.readLinkSync(path.join(root, name)) }
            : {}),
        });
      } else {throw new PluginContractError(
          409,
          "permission_source_invalid",
          "plugin code contains an unsupported entry",
        );}
    }
    visited.delete(directory);
  }
  visit();
  return sourceDigest(JSON.stringify(rows));
}
