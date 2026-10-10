// SPDX-License-Identifier: LGPL-3.0-only

/** Vault-owned JSON persistence. No runtime, HTTP, auth or global-state imports. */
import * as path from "@std/path";
import {
  type JsonValues,
  jsonValues,
  PLUGIN_LIMITS,
  PluginContractError,
  pluginId,
  record,
  type RevisionedValues,
  uniqueStrings,
} from "./contracts.ts";
import {
  assertSettingsSchemaCurrent,
  effectivePageValues,
  validateSettingsPages,
} from "./settings.ts";
import type { SettingsPage } from "./contracts.ts";
import {
  PluginSettingsEnvironment,
  type SettingsContext,
} from "./settings_environment.ts";

export interface PersistenceAdapters {
  /** Captured epoch/generation is checked inside the short host commit gate. */
  commit<T>(effect: () => Promise<T>): Promise<T>;
  settingsChanged?(id: string, page: string, revision: number): void;
  /** Owning source adapter; persistence does not import runtime/global state. */
  settingsSchema?(id: string): SettingsPage[];
  settingsEnvironment?: PluginSettingsEnvironment;
  settingsContext?(id: string): SettingsContext;
  /** Prepared host-only transition; no network/runtime/global imports here. */
  prepareSettingsCommit?(
    change: SettingsCommitChange,
  ): Promise<PreparedSettingsCommit>;
}
export interface SettingsCommitChange {
  readonly pluginId: string;
  readonly pageId: string;
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly definition: SettingsPage;
}
export interface PreparedSettingsCommit {
  /** Pure source/CAS validation under the same short lifecycle gate. */
  validateLedgerSnapshot(): Promise<void> | void;
  /** Synchronous schema/source assertion before final authority and rename. */
  assertSchemaCurrent(): void;
  /** Synchronous retirement immediately after the settings rename. */
  fenceCommittedSettings(): void;
  /** Ledger writer/recovery admission runs only after releasing that gate. */
  publishRetirement(): Promise<void>;
}
const writers = new Map<string, Promise<unknown>>();
async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writers.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  writers.set(key, current);
  try {
    return await current;
  } finally {
    if (writers.get(key) === current) writers.delete(key);
  }
}
function stateError(code: string, detail: string, status = 409): never {
  throw new PluginContractError(status, code, detail);
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    stateError(
      "invalid_plugin_revision",
      "revision must be a non-negative safe integer",
      422,
    );
  }
  return value as number;
}
/** Resolve a configured root even before its first persistence operation. */
function canonicalRoot(input: string): string {
  try {
    return Deno.realPathSync(input);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const parent = path.dirname(input);
    if (parent === input) throw error;
    return path.join(canonicalRoot(parent), path.basename(input));
  }
}

/** A state-root symlink is configuration; symlinks below it cannot choose owners. */
function ownedPath(root: string, parts: string[]): string {
  let candidate = root;
  for (const part of parts) {
    candidate = path.join(candidate, part);
    try {
      if (Deno.lstatSync(candidate).isSymlink) {
        stateError(
          "plugin_namespace_denied",
          "plugin state paths cannot be symlinks",
          403,
        );
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return candidate;
}
async function readJson(
  file: string,
): Promise<{ raw: string | null; value: Record<string, unknown> | null }> {
  try {
    // Bound reads before allocating/parsing a maliciously large state file.
    if ((await Deno.stat(file)).size > PLUGIN_LIMITS.controlBytes) {
      stateError("plugin_state_too_large", "plugin state exceeds 1 MiB", 413);
    }
    const raw = await Deno.readTextFile(file);
    try {
      return { raw, value: record(JSON.parse(raw), "persisted plugin state") };
    } catch {
      stateError(
        "plugin_state_corrupt",
        "persisted plugin state is malformed; original file retained",
      );
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { raw: null, value: null };
    }
    throw error;
  }
}
/** Final CAS reads are synchronous and use the same owned 1 MiB envelope.
 * No lifecycle/generation authority may be lent across an I/O await here. */
function readJsonSync(
  file: string,
): { raw: string | null; value: Record<string, unknown> | null } {
  try {
    if (Deno.statSync(file).size > PLUGIN_LIMITS.controlBytes) {
      stateError("plugin_state_too_large", "plugin state exceeds 1 MiB", 413);
    }
    const raw = Deno.readTextFileSync(file);
    try {
      return { raw, value: record(JSON.parse(raw), "persisted plugin state") };
    } catch {
      stateError(
        "plugin_state_corrupt",
        "persisted plugin state is malformed; original file retained",
      );
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { raw: null, value: null };
    }
    throw error;
  }
}
function envelope(value: Record<string, unknown> | null): RevisionedValues {
  if (!value) return { schemaVersion: 1, revision: 0, values: {} };
  if (value.schemaVersion !== 1) {
    stateError(
      "plugin_state_unsupported",
      "unsupported plugin state schema; original file retained",
    );
  }
  try {
    return {
      schemaVersion: 1,
      revision: revision(value.revision),
      values: jsonValues(value.values),
    };
  } catch {
    stateError(
      "plugin_state_corrupt",
      "invalid persisted plugin values; original file retained",
    );
  }
}
async function atomicReplace(
  file: string,
  values: unknown,
  commit: PersistenceAdapters["commit"],
  revalidate: () => void,
  assertFinal?: () => void,
  transition?: PreparedSettingsCommit,
): Promise<void> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(values, null, 2) + "\n",
  );
  if (bytes.length > PLUGIN_LIMITS.controlBytes) {
    stateError("plugin_payload_too_large", "plugin state exceeds 1 MiB", 413);
  }
  await Deno.mkdir(path.dirname(file), { recursive: true });
  const temporary = await Deno.makeTempFile({
    dir: path.dirname(file),
    prefix: ".plugin-",
  });
  let failed = false;
  let failure: unknown;
  try {
    const handle = await Deno.open(temporary, { write: true });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += await handle.write(bytes.subarray(offset));
      }
      await handle.sync();
    } finally {
      handle.close();
    }
    await commit(async () => {
      if (transition) await transition.validateLedgerSnapshot();
      revalidate();
      transition?.assertSchemaCurrent();
      assertFinal?.();
      Deno.renameSync(temporary, file);
      transition?.fenceCommittedSettings();
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await Deno.remove(temporary);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      failure = failed
        ? new AggregateError(
          [failure, error],
          "plugin write and temporary-file cleanup failed",
        )
        : error;
      failed = true;
    }
  }
  if (failed) throw failure;
}

/** The owning host constructs one namespace facade; RPC never supplies an ID. */
export class PluginDataStore {
  readonly stateRoot: string;
  constructor(
    stateRoot: string,
    private readonly adapters: PersistenceAdapters,
  ) {
    this.stateRoot = canonicalRoot(path.resolve(stateRoot));
  }

  forPlugin(
    id: string,
    settingsGuard?: () => void,
    assertRequester?: () => void,
  ) {
    pluginId(id);
    const file = (kind: "settings" | "data") =>
      ownedPath(this.stateRoot, ["plugin-data", id, `${kind}.json`]);
    const load = async (kind: "settings" | "data") =>
      envelope((await readJson(file(kind))).value);
    const environment = this.adapters.settingsEnvironment ??
      new PluginSettingsEnvironment();
    const bindSchema = (pages: SettingsPage[], complete = false) => {
      const captured = validateSettingsPages(pages);
      const context = this.adapters.settingsContext?.(id);
      const assertCurrent = () => {
        if (this.adapters.settingsSchema) {
          assertSettingsSchemaCurrent(
            captured,
            this.adapters.settingsSchema(id),
            complete,
          );
        }
        context?.assertCurrent();
      };
      assertCurrent();
      return { pages: captured, assertCurrent, context };
    };
    const update = async (
      kind: "settings" | "data",
      expected: number,
      change: (current: JsonValues) => JsonValues,
      definition?: SettingsPage,
      assertSchema?: () => void,
      source?: { key?: string; context?: SettingsContext },
    ) => {
      const target = file(kind);
      return await serialize(target, async () => {
        assertSchema?.();
        revision(expected);
        const before = await readJson(target);
        const current = envelope(before.value);
        if (
          source?.key !== undefined &&
          (!source.context ||
            source.key !== source.context.key(current.revision))
        ) {
          stateError(
            "plugin_settings_source_conflict",
            "plugin settings source changed; review current values before retrying",
          );
        }
        if (current.revision !== expected) {
          stateError(
            "plugin_revision_conflict",
            "plugin values changed; reload before committing",
          );
        }
        const next: RevisionedValues = {
          schemaVersion: 1,
          revision: revision(current.revision + 1),
          values: jsonValues(change(current.values)),
        };
        const preparedTransition = kind === "settings" && definition &&
            this.adapters.prepareSettingsCommit
          ? await this.adapters.prepareSettingsCommit({
            pluginId: id,
            pageId: definition.id,
            previousRevision: current.revision,
            nextRevision: next.revision,
            definition,
          })
          : undefined;
        let settingsCommitted = false;
        let failedAfterCommit = false;
        let persistedFailure: unknown;
        const transition = preparedTransition
          ? {
            validateLedgerSnapshot: () =>
              preparedTransition.validateLedgerSnapshot(),
            assertSchemaCurrent: () => preparedTransition.assertSchemaCurrent(),
            fenceCommittedSettings: () => {
              settingsCommitted = true;
              preparedTransition.fenceCommittedSettings();
            },
            publishRetirement: () => preparedTransition.publishRetirement(),
          }
          : undefined;
        try {
          await atomicReplace(
            target,
            next,
            this.adapters.commit.bind(this.adapters),
            () => {
              file(kind);
              if (readJsonSync(target).raw !== before.raw) {
                stateError(
                  "plugin_revision_conflict",
                  "plugin state changed during persistence",
                );
              }
            },
            () => {
              assertSchema?.();
              if (kind === "settings") settingsGuard?.();
              assertRequester?.();
            },
            transition,
          );
        } catch (error) {
          if (!settingsCommitted) throw error;
          failedAfterCommit = true;
          persistedFailure = error;
        }
        if (transition) {
          try {
            await transition.publishRetirement();
            if (failedAfterCommit) throw persistedFailure;
          } catch (error) {
            throw new PluginContractError(
              503,
              "plugin_settings_source_commit_failed",
              `Settings revision ${next.revision} persisted, but permission-source publication or recovery admission failed; read back the committed settings before an explicit retry. ${
                error instanceof Error ? error.message : "source commit failed"
              }`,
            );
          }
        }
        return next;
      });
    };
    return Object.freeze({
      /** Host-only synchronous lease for completion IO; never enters Worker messages. */
      settingsLease: (pages: SettingsPage[]) => {
        const binding = bindSchema(pages, true),
          target = file("settings"),
          before = readJsonSync(target),
          current = envelope(before.value);
        const values = Object.fromEntries(
          binding.pages.map((
            page,
          ) => [
            page.id,
            environment.project(
              id,
              page,
              Object.hasOwn(current.values, page.id)
                ? current.values[page.id]
                : {},
              binding.pages,
            ).values,
          ]),
        );
        return {
          revision: current.revision,
          values,
          sourceKey: binding.context?.key(current.revision),
          codeFingerprint: binding.context?.codeFingerprint,
          assertCurrent: () => {
            binding.assertCurrent();
            file("settings");
            if (readJsonSync(target).raw !== before.raw) {
              stateError(
                "plugin_settings_source_conflict",
                "plugin effective settings changed before filesystem effect",
              );
            }
          },
        };
      },
      load: () => load("data"),
      save: (values: unknown, expected: number) =>
        update("data", expected, () => jsonValues(values)),
      settings: async (pages: SettingsPage[]) => {
        const binding = bindSchema(pages, true);
        const current = await load("settings");
        binding.assertCurrent();
        return {
          ...current,
          ...(binding.context
            ? { sourceKey: binding.context.key(current.revision) }
            : {}),
          fields: Object.fromEntries(
            binding.pages.map((
              page,
            ) => [
              page.id,
              environment.project(
                id,
                page,
                Object.hasOwn(current.values, page.id)
                  ? current.values[page.id]
                  : {},
                binding.pages,
              ).fields,
            ]),
          ),
          values: Object.fromEntries(
            binding.pages.map((
              p,
            ) => [
              p.id,
              environment.project(
                id,
                p,
                Object.hasOwn(current.values, p.id) ? current.values[p.id] : {},
                binding.pages,
              ).values,
            ]),
          ),
        };
      },
      page: async (page: SettingsPage) => {
        const binding = bindSchema([page]);
        const current = await load("settings");
        binding.assertCurrent();
        const captured = binding.pages[0];
        return {
          ...current,
          ...(binding.context
            ? { sourceKey: binding.context.key(current.revision) }
            : {}),
          ...environment.project(
            id,
            captured,
            Object.hasOwn(current.values, captured.id)
              ? current.values[captured.id]
              : {},
            this.adapters.settingsSchema?.(id) ?? [captured],
          ),
        };
      },
      savePage: async (
        page: SettingsPage,
        values: unknown,
        expected: number,
        sourceKey?: string,
      ) => {
        const binding = bindSchema([page]);
        const captured = binding.pages[0];
        const validated = effectivePageValues(captured, values);
        const pins = environment.pages(
          id,
          this.adapters.settingsSchema?.(id) ?? [captured],
        )[captured.id] ?? {};
        for (const [key, value] of Object.entries(pins)) {
          if (validated[key] !== value) {
            stateError(
              "plugin_setting_pinned",
              "the environment-pinned field cannot be changed",
            );
          }
        }
        const committed = await update(
          "settings",
          expected,
          (current) => {
            environment.project(
              id,
              captured,
              Object.hasOwn(current, captured.id) ? current[captured.id] : {},
              this.adapters.settingsSchema?.(id) ?? [captured],
            );
            return ({
              ...current,
              [captured.id]: {
                ...jsonValues(
                  Object.hasOwn(current, captured.id)
                    ? current[captured.id]
                    : {},
                ),
                ...Object.fromEntries(
                  Object.entries(validated).filter(([key]) =>
                    !Object.hasOwn(pins, key)
                  ),
                ),
              },
            });
          },
          captured,
          binding.assertCurrent,
          { key: sourceKey, context: binding.context },
        );
        // Persistence has completed. Callback failures cannot undo a committed value.
        this.adapters.settingsChanged?.(id, captured.id, committed.revision);
        return {
          ...committed,
          ...(binding.context
            ? { sourceKey: binding.context.key(committed.revision) }
            : {}),
          ...environment.project(
            id,
            captured,
            committed.values[captured.id],
            this.adapters.settingsSchema?.(id) ?? [captured],
          ),
        };
      },
    });
  }
}

export interface PluginPolicyMetadata {
  revision: number;
  signature: string;
  effectiveAutoEnable: boolean;
  autoEnableSource: "environment" | "vault" | "default";
}
export interface PluginPolicy extends Record<string, unknown> {
  order?: string[];
  disabled?: string[];
  enabled?: string[];
  autoEnable?: boolean;
  revision?: number;
}
function validatePolicy(value: Record<string, unknown> | null): PluginPolicy {
  if (!value) return {};
  try {
    for (const key of ["order", "disabled", "enabled"]) {
      if (value[key] !== undefined) {
        for (const id of uniqueStrings(value[key], `policy ${key}`)) {
          pluginId(id);
        }
      }
    }
    if (
      value.autoEnable !== undefined && typeof value.autoEnable !== "boolean"
    ) throw new Error("invalid autoEnable");
    if (value.revision !== undefined) revision(value.revision);
    return value as PluginPolicy;
  } catch {
    stateError(
      "plugin_policy_corrupt",
      "plugin policy is invalid; original file retained",
    );
  }
}
export function policyEnables(
  policy: PluginPolicy,
  id: string,
  automatic: boolean,
): boolean {
  if (policy.disabled?.includes(id)) return false;
  if (policy.enabled?.includes(id)) return true;
  return automatic;
}
export class PluginPolicyStore {
  readonly stateRoot: string;
  constructor(
    stateRoot: string,
    private readonly adapters: PersistenceAdapters,
    private readonly defaults: { autoEnable: boolean; environment?: boolean } =
      { autoEnable: true },
  ) {
    this.stateRoot = canonicalRoot(path.resolve(stateRoot));
  }
  private file() {
    return ownedPath(this.stateRoot, ["plugins.json"]);
  }
  /** Legacy module/style/render listing is synchronous. Never substitutes empty policy on corruption. */
  selection(): { policy: PluginPolicy; automatic: boolean } {
    let value: Record<string, unknown> | null = null;
    try {
      const target = this.file();
      if (Deno.statSync(target).size > PLUGIN_LIMITS.controlBytes) {
        stateError(
          "plugin_state_too_large",
          "plugin policy exceeds 1 MiB",
          413,
        );
      }
      try {
        value = record(
          JSON.parse(Deno.readTextFileSync(target)),
          "plugin policy",
        );
      } catch {
        stateError(
          "plugin_policy_corrupt",
          "plugin policy is malformed; original file retained",
        );
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const policy = validatePolicy(value);
    return {
      policy,
      automatic: this.defaults.environment ?? policy.autoEnable ??
        this.defaults.autoEnable,
    };
  }
  private async snapshot() {
    const input = await readJson(this.file());
    const policy = validatePolicy(input.value);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        input.raw === null ? "absent-plugin-policy-v1" : `present:${input.raw}`,
      ),
    );
    const pinned = this.defaults.environment !== undefined;
    const metadata: PluginPolicyMetadata = {
      revision: policy.revision ?? 0,
      signature: [...new Uint8Array(digest)].map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join(""),
      effectiveAutoEnable: pinned
        ? this.defaults.environment!
        : policy.autoEnable ?? this.defaults.autoEnable,
      autoEnableSource: pinned
        ? "environment"
        : policy.autoEnable !== undefined
        ? "vault"
        : "default",
    };
    return { policy, metadata, raw: input.raw };
  }
  async read() {
    const { policy, metadata } = await this.snapshot();
    return { policy, metadata };
  }
  private async write(
    expected: { revision: number; signature: string },
    change: (
      policy: PluginPolicy,
      metadata: PluginPolicyMetadata,
    ) => PluginPolicy,
    settingsGuard?: () => void,
  ) {
    return await serialize(this.file(), async () => {
      const before = await this.snapshot();
      if (
        revision(expected.revision) !== before.metadata.revision ||
        expected.signature !== before.metadata.signature
      ) {
        stateError(
          "plugin_policy_conflict",
          "plugin policy changed; reload before committing",
        );
      }
      const next = change(before.policy, before.metadata);
      next.revision = revision(before.metadata.revision + 1);
      const target = this.file();
      await atomicReplace(
        target,
        next,
        this.adapters.commit.bind(this.adapters),
        () => {
          this.file();
          if (readJsonSync(target).raw !== before.raw) {
            stateError(
              "plugin_policy_conflict",
              "plugin policy changed during persistence",
            );
          }
        },
        settingsGuard,
      );
      return await this.read();
    });
  }
  async setEnabled(
    id: string,
    enabled: boolean,
    expected: { revision: number; signature: string },
    settingsGuard?: () => void,
  ) {
    pluginId(id);
    if (typeof enabled !== "boolean") {
      stateError("invalid_plugin_policy", "enabled must be a boolean", 422);
    }
    return await this.write(expected, (policy) => ({
      ...policy,
      enabled: [
        ...new Set([
          ...(policy.enabled ?? []).filter((value) => value !== id),
          ...(enabled ? [id] : []),
        ]),
      ],
      disabled: [
        ...new Set([
          ...(policy.disabled ?? []).filter((value) => value !== id),
          ...(enabled ? [] : [id]),
        ]),
      ],
    }), settingsGuard);
  }
  async setAutoEnable(
    autoEnable: boolean,
    inventory: string[],
    expected: { revision: number; signature: string },
    settingsGuard?: () => void,
  ) {
    if (typeof autoEnable !== "boolean") {
      stateError("invalid_plugin_policy", "autoEnable must be a boolean", 422);
    }
    return await this.write(expected, (policy, metadata) => {
      if (metadata.autoEnableSource === "environment") {
        stateError(
          "policy_pinned",
          "auto-enable is pinned by GLOBNOTES_AUTO_ENABLE_PLUGINS",
        );
      }
      const enabled = new Set(policy.enabled ?? []);
      const disabled = new Set(policy.disabled ?? []);
      for (const id of inventory) {
        pluginId(id);
        if (policyEnables(policy, id, metadata.effectiveAutoEnable)) {
          enabled.add(id);
          disabled.delete(id);
        } else {
          disabled.add(id);
          enabled.delete(id);
        }
      }
      return {
        ...policy,
        autoEnable,
        enabled: [...enabled],
        disabled: [...disabled],
      };
    }, settingsGuard);
  }
}
