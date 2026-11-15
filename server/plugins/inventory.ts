// SPDX-License-Identifier: LGPL-3.0-only
/** One installed roster/source owner. Policy and Worker generations live above it. */
import * as path from "@std/path";
import {
  HOOK_NAMES,
  type HookName,
  PluginContractError,
  type PluginDiagnostic,
  pluginId,
} from "./contracts.ts";
import {
  discoverPluginDirs,
  pluginCodePath,
  type PluginManifest,
  readManifest,
} from "./manifest.ts";
import { installedSource, sourceDigest } from "./installed_source.ts";

export interface InstalledPlugin {
  id: string;
  dir: string;
  revision: number;
  identity: string;
  fingerprint?: string;
  manifest?: PluginManifest;
  diagnostic?: PluginDiagnostic;
  hooks: HookName[];
}
export interface InstalledPluginLease {
  entry: InstalledPlugin;
  assertCurrent(): void;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function declaredHooks(text?: string): HookName[] {
  try {
    const raw = JSON.parse(text ?? "");
    return Array.isArray(raw?.hooks)
      ? [
        ...new Set(raw.hooks.filter((hook: unknown): hook is HookName =>
          typeof hook === "string" && HOOK_NAMES.includes(hook as HookName)
        )),
      ] as HookName[]
      : [];
  } catch {
    return [];
  }
}
export class InstalledPluginInventory {
  #entries = new Map<string, InstalledPlugin>();
  #snapshot: readonly InstalledPlugin[] = [];
  #initialized = false;
  #revision = 0;
  #sequence = 0;
  #validationError: unknown;
  constructor(
    private readonly roots: readonly string[],
    private readonly validate: (entries: readonly InstalledPlugin[]) => void =
      () => {},
  ) {}
  get revision(): number {
    return this.#revision;
  }
  private ensure() {
    if (!this.#initialized) this.refresh();
  }
  private assertValid() {
    if (this.#validationError) throw this.#validationError;
  }
  snapshot(): readonly InstalledPlugin[] {
    this.ensure();
    this.assertValid();
    return this.#snapshot;
  }
  get(id: string): InstalledPlugin | undefined {
    this.snapshot();
    return this.#entries.get(id);
  }
  private read(id: string, dir: string): InstalledPlugin {
    const previous = this.#entries.get(id);
    let source;
    try {
      source = installedSource(dir);
    } catch (error) {
      // Invalid code still owns its ID and its declared protection. It cannot
      // select an older implementation or obtain a source lease.
      let text: string | undefined;
      try {
        text = Deno.readTextFileSync(pluginCodePath(dir, "manifest.json"));
      } catch { /* unavailable */ }
      const detail = error instanceof Error
        ? error.message
        : "invalid plugin source";
      const identity = sourceDigest(JSON.stringify({ dir, text, detail }));
      if (previous?.dir === dir && previous.identity === identity) {
        return previous;
      }
      return freeze({
        id,
        dir,
        identity,
        revision: ++this.#sequence,
        hooks: declaredHooks(text),
        diagnostic: { code: "plugin_manifest_invalid", detail },
      });
    }
    if (previous?.dir === dir && previous.identity === source.identity) {
      return previous;
    }
    const base = {
      id,
      dir,
      identity: source.identity,
      fingerprint: source.fingerprint,
      revision: ++this.#sequence,
    };
    try {
      const manifest = readManifest(dir, source);
      return freeze({ ...base, manifest, hooks: manifest.hooks });
    } catch (error) {
      return freeze({
        ...base,
        hooks: declaredHooks(source.manifestText),
        diagnostic: {
          code: "plugin_manifest_invalid",
          detail: error instanceof Error
            ? error.message
            : "invalid plugin manifest",
        },
      });
    }
  }
  private publish(entries: Map<string, InstalledPlugin>) {
    const changed = !this.#initialized || entries.size !== this.#entries.size ||
      [...entries].some(([id, entry]) => this.#entries.get(id) !== entry);
    const next = [...entries.values()];
    // A targeted admission may discover an ID before the next ordered scan.
    // Adopt that scan's order without inventing another installed-source change.
    const reordered = this.#snapshot.some((entry, index) =>
      entry.id !== next[index]?.id
    );
    if (changed || reordered) {
      this.#entries = entries;
      this.#snapshot = Object.freeze(next);
    }
    if (changed) {
      this.#revision++;
      this.#initialized = true;
      this.#validationError = undefined;
      try {
        this.validate(this.#snapshot);
      } catch (error) {
        this.#validationError = error;
      }
    }
    this.assertValid();
  }
  refresh(): readonly InstalledPlugin[] {
    const selected = new Map<string, string>();
    for (const root of this.roots) {
      for (const dir of discoverPluginDirs(root)) {
        selected.set(path.basename(dir), dir);
      }
    }
    const entries = new Map<string, InstalledPlugin>();
    for (const [id, dir] of selected) entries.set(id, this.read(id, dir));
    this.publish(entries);
    return this.#snapshot;
  }
  current(id: string): InstalledPlugin | undefined {
    pluginId(id);
    this.ensure();
    let selected: string | undefined;
    for (const root of this.roots) {
      const dir = path.join(root, id);
      try {
        if (Deno.lstatSync(dir).isDirectory) selected = dir;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    const entry = selected ? this.read(id, selected) : undefined;
    if (entry !== this.#entries.get(id)) {
      const entries = new Map(this.#entries);
      if (entry) entries.set(id, entry);
      else entries.delete(id);
      this.publish(entries);
    }
    this.assertValid();
    return entry;
  }
  lease(id: string): InstalledPluginLease {
    const entry = this.current(id);
    const conflict = () =>
      new PluginContractError(
        409,
        "plugin_settings_source_conflict",
        "plugin installed configuration source changed",
      );
    if (!entry?.manifest || !entry.fingerprint) throw conflict();
    return {
      entry,
      assertCurrent: () => {
        try {
          if (this.current(id) === entry) return;
        } catch { /* fail closed */ }
        throw conflict();
      },
    };
  }
}
