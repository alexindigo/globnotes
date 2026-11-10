// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import { HttpError } from "@pathfinder/pathfinder";
import { type ObservedClock, processClock } from "../../observed_time.ts";
import {
  type JsonValues,
  PluginContractError,
  record,
} from "../../plugins/contracts.ts";
import { type PluginLifecycle } from "../../plugins/lifecycle.ts";
import type { DriverOwners, PluginManager } from "../../plugins/manager.ts";
import {
  driverSettingsPage,
  type PluginManifest,
} from "../../plugins/manifest.ts";
import {
  equalSource,
  intersectScopes,
  type PermissionDeclaration,
  scopesCover,
  type Source,
} from "../../plugins/network_contracts.ts";
import { permissionFingerprint } from "../../plugins/network_permissions.ts";
import type {
  NetworkPolicy,
  SettingsOwnerRecovery,
} from "../../plugins/network_requests.ts";
import { DriverWorker } from "../../plugins/runtime.ts";
import {
  effectivePageValues,
  projectPageValues,
} from "../../plugins/settings.ts";
import type { NoteOperations } from "../../notes/operations.ts";
import type { VaultHub } from "../hub.ts";
import {
  type DriverInstance,
  DriverPeers,
  PeerRevisionConflict,
} from "./peers.ts";
import { driverRedactor } from "./redact.ts";
import { DriverSecrets } from "./secrets.ts";
import {
  type DriverDecision,
  DriverSession,
  type DriverSessionView,
} from "./session.ts";

interface Slot {
  instance: DriverInstance;
  epoch: number;
  access: number;
  retired: boolean;
  source?: Source;
  policy?: NetworkPolicy;
  ceiling?: PermissionDeclaration;
  worker?: DriverWorker;
  session?: DriverSession;
  pending?: Promise<void>;
  view: DriverSessionView | {
    status: "off";
    reason: string | null;
    lastSync: null;
    error: null;
    attention: null;
  };
  attempts: number;
  nextFull: number;
  nextExport: number;
  nextRetry: number;
  activity: "receiving" | "sending" | null;
  activityUntil: number;
}
export interface SupervisorAdapters {
  hub: VaultHub;
  operations: Pick<NoteOperations, "applyDriverImport">;
  plugins: PluginManager;
  lifecycle: PluginLifecycle;
  clock?: ObservedClock;
}

/** One vault owns instances, keys, scheduling and generation admission together.
 * PluginManager calls the same synchronous fences as its service/render roles. */
export class DriverSupervisor implements DriverOwners {
  readonly peers: DriverPeers;
  readonly #secrets: DriverSecrets;
  readonly #slots = new Map<string, Slot>();
  readonly #retirements = new Set<Promise<void>>();
  readonly #listeners = new Set<(revision: number) => void>();
  readonly #off: (() => void)[] = [];
  readonly #clock: ObservedClock;
  #revision: number;
  #closed = false;
  constructor(readonly adapters: SupervisorAdapters) {
    this.peers = new DriverPeers(adapters.hub.store);
    this.#secrets = new DriverSecrets(adapters.hub.stateRoot);
    this.#clock = adapters.clock ?? processClock;
    this.#revision = this.peers.nextAttentionRevision();
    this.#off.push(
      adapters.hub.subscribe((entries) => {
        for (const slot of this.#slots.values()) {
          slot.session?.observe(entries);
          if (!slot.retired && slot.session && slot.nextExport === Infinity) {
            slot.nextExport = this.#clock.now() + 1000;
          }
        }
      }),
      adapters.lifecycle.onPolicyChange(() => this.suspend()),
      this.#clock.every(() => this.#tick()),
    );
  }
  revision(): number {
    return this.#revision;
  }
  subscribe(listener: (revision: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #changed = (): void => {
    if (this.#closed) return;
    for (const slot of this.#slots.values()) {
      this.#projectActivity(slot);
      const view = !slot.retired && (!slot.worker || slot.worker.current())
        ? slot.session?.snapshot() ?? slot.view
        : slot.view;
      // An enabled replacement's temporary Off/Starting projection is not
      // recovery. Off with a reason is a real unavailable-plugin state.
      if (view.status !== "off" || view.reason || !slot.instance.enabled) {
        this.peers.observeStatus(
          slot.instance.id,
          view.status,
          slot.instance.enabled,
        );
      }
    }
    this.#revision = this.peers.nextAttentionRevision();
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#revision);
      } catch { /* isolate disconnected consumers */ }
    }
  };
  #instance(id: string, revision?: number): DriverInstance {
    const instance = this.peers.instance(id);
    if (!instance) throw new HttpError(404, "Not Found");
    if (revision !== undefined && instance.revision !== revision) {
      throw new PeerRevisionConflict();
    }
    return instance;
  }
  #definition(plugin: string, enabled = false): PluginManifest {
    const owner = this.adapters.plugins.driverOwner(plugin);
    if (!owner.manifest?.driver || enabled && !owner.enabled) {
      throw new HttpError(404, "Sync plugin not found");
    }
    return owner.manifest;
  }
  #current(slot: Slot): boolean {
    const owner = this.adapters.plugins.driverOwner(slot.instance.plugin);
    return !this.#closed && !slot.retired &&
      this.#slots.get(slot.instance.id) === slot &&
      owner.enabled && owner.epoch === slot.epoch && !!owner.manifest?.driver &&
      this.adapters.lifecycle.epoch === slot.access &&
      this.adapters.lifecycle.writable() &&
      this.peers.instance(slot.instance.id)?.revision ===
        slot.instance.revision;
  }
  #retire(slot: Slot): void {
    slot.retired = true;
    slot.nextFull = slot.nextExport = slot.nextRetry = Infinity;
    slot.session?.retire();
    slot.worker?.stop();
    const settled = Promise.all([slot.pending, slot.session?.settle()]).then(
      () => undefined,
    );
    this.#retirements.add(settled);
    settled.finally(() => this.#retirements.delete(settled)).catch(() =>
      undefined
    );
  }
  ownerIds(): string[] {
    return [
      ...new Set(this.peers.instances().map((instance) => instance.plugin)),
    ];
  }
  ownerSources(id: string): Source[] {
    return [...this.#slots.values()].flatMap((slot) =>
      slot.instance.plugin === id && slot.source ? [slot.source] : []
    );
  }
  retireOwner(id: string): void {
    for (const [key, slot] of this.#slots) {
      if (slot.instance.plugin !== id) continue;
      this.#retire(slot);
      this.#slots.delete(key);
    }
    this.#changed();
  }
  suspend(): void {
    for (const slot of this.#slots.values()) this.#retire(slot);
    this.#changed();
    // Access changes fence synchronously; replacement observes the committed policy.
    queueMicrotask(() => {
      if (!this.#closed) this.reconcile().catch(() => undefined);
    });
  }
  #newSlot(
    instance: DriverInstance,
    previous?: Slot,
    admission?: NetworkPolicy,
  ): Slot {
    const owner = this.adapters.plugins.driverOwner(instance.plugin);
    const reason = !instance.enabled
      ? null
      : !owner.enabled
      ? "plugin_disabled"
      : !owner.manifest?.driver
      ? "plugin_unavailable"
      : null;
    const slot: Slot = {
      instance: structuredClone(instance),
      epoch: owner.epoch,
      access: this.adapters.lifecycle.epoch,
      retired: false,
      source: previous?.source,
      // Automatic retries cannot acquire an expansion whose SDK receipt has
      // not settled. Only an admitted permission replacement changes this ceiling.
      ceiling: admission?.effective ?? previous?.ceiling ??
        previous?.policy?.effective,
      attempts: previous?.attempts ?? 0,
      view: {
        status: "off",
        reason,
        lastSync: null,
        error: null,
        attention: null,
      },
      nextFull: Infinity,
      nextExport: Infinity,
      nextRetry: Infinity,
      activity: null,
      activityUntil: 0,
    };
    this.#slots.set(instance.id, slot);
    if (instance.enabled && owner.enabled && owner.manifest?.driver) {
      if (!this.adapters.lifecycle.writable()) {
        slot.view = this.#state("paused", "read-only vault");
      } else slot.nextFull = this.#clock.now();
    }
    return slot;
  }
  #state(
    status: DriverSessionView["status"],
    reason: string | null = null,
  ): DriverSessionView {
    return {
      status,
      reason,
      error: null,
      lastSync: null,
      attention: {
        revision: this.peers.nextAttentionRevision(),
        held: [],
        remoteEmpty: null,
        issues: [],
        notices: [],
      },
    };
  }
  async reconcile(): Promise<void> {
    if (this.#closed) return;
    const ids = new Set<string>();
    const starts: Promise<void>[] = [];
    for (const instance of this.peers.instances()) {
      ids.add(instance.id);
      let slot = this.#slots.get(instance.id);
      const owner = this.adapters.plugins.driverOwner(instance.plugin);
      if (
        slot &&
        (slot.instance.revision !== instance.revision ||
          slot.epoch !== owner.epoch ||
          slot.access !== this.adapters.lifecycle.epoch)
      ) {
        this.#retire(slot);
        slot = undefined;
      }
      if (!slot || slot.retired) slot = this.#newSlot(instance, slot);
      if (slot.nextFull <= this.#clock.now()) {
        starts.push(this.#run(slot, true));
      }
    }
    for (const [id, slot] of this.#slots) {
      if (!ids.has(id)) {
        this.#retire(slot);
        this.#slots.delete(id);
      }
    }
    this.#changed();
    await Promise.all(starts);
  }
  #tick(): void {
    if (this.#closed) return;
    const now = this.#clock.now();
    let activityChanged = false;
    for (let slot of this.#slots.values()) {
      activityChanged = this.#projectActivity(slot) || activityChanged;
      if (slot.pending) continue;
      if (slot.nextRetry <= now) {
        this.#retire(slot);
        slot = this.#newSlot(this.#instance(slot.instance.id), slot);
      }
      if (slot.nextFull <= now) this.#run(slot, true);
      else if (slot.nextExport <= now) this.#run(slot, false);
    }
    if (activityChanged) this.#changed();
  }
  #projectActivity(slot: Slot): boolean {
    const before = slot.activity;
    const actual = !slot.retired && slot.instance.enabled
      ? slot.session?.activity() ?? null
      : null;
    if (slot.retired || !slot.instance.enabled) slot.activity = null;
    else if (actual) {
      if (actual !== slot.activity) {
        slot.activityUntil = this.#clock.now() + 1000;
      }
      slot.activity = actual;
    } else if (this.#clock.now() >= slot.activityUntil) slot.activity = null;
    return before !== slot.activity;
  }
  #run(slot: Slot, full: boolean): Promise<void> {
    if (slot.pending) {
      if (full) slot.nextFull = this.#clock.now();
      return slot.pending;
    }
    if (!this.#current(slot)) return Promise.resolve();
    if (full) slot.nextFull = Infinity;
    slot.nextExport = slot.nextRetry = Infinity;
    const work = this.#cycle(slot, full).catch(() => {
      slot.worker?.stop();
      if (this.#current(slot)) {
        slot.view = this.#state("failed", "driver_start_failed");
      }
    }).then(() => {
      if (!this.#current(slot)) return;
      const view = slot.worker && !slot.worker.current()
        ? slot.view
        : slot.session?.snapshot() ?? slot.view;
      slot.view = view;
      if (view.status === "failed") {
        slot.nextRetry = this.#clock.now() +
          Math.max(
            Math.min(5000 * 2 ** slot.attempts++, 300_000),
            view.error?.retryAfterMs ?? 0,
          );
      } else if (view.status === "active") {
        slot.attempts = 0;
        slot.nextFull = Math.min(slot.nextFull, this.#clock.now() + 60_000);
        const retry = this.peers.files(slot.instance.id).filter((row) =>
          ["pending", "uncertain", "delete-pending"].includes(row.state)
        );
        if (retry.length) {
          slot.nextFull = Math.min(
            slot.nextFull,
            Math.max(
              this.#clock.now() + 1000,
              Math.min(...retry.map((row) => row.nextAt)),
            ),
          );
        }
      }
      this.#changed();
    }).finally(() => {
      if (slot.pending === work) slot.pending = undefined;
    });
    slot.pending = work;
    return work;
  }
  async #cycle(slot: Slot, full: boolean): Promise<void> {
    const { plugins, hub, lifecycle, operations } = this.adapters;
    const manifest = this.#definition(slot.instance.plugin, true);
    const missing = this.#secrets.status(
      slot.instance.id,
      manifest.driver!.secrets,
    ).find((key) => key.required !== false && !key.set);
    if (missing) {
      slot.view = this.#state("locked", `needs ${missing.label}`);
      return;
    }
    if (!slot.worker) {
      slot.view = this.#state("starting");
      this.#changed();
      const policy = await plugins.network.policy(manifest.id);
      if (!this.#current(slot)) return;
      if (
        slot.source &&
        slot.source.codeFingerprint !== policy.source.codeFingerprint
      ) {
        slot.view = this.#state("failed", "source-reload-required");
        return;
      }
      const latest = await plugins.network.policy(manifest.id);
      if (!this.#current(slot)) return;
      if (
        !equalSource(policy.source, latest.source) ||
        policy.fingerprint !== latest.fingerprint
      ) throw new PeerRevisionConflict();
      const effective = slot.ceiling
        ? {
          network: intersectScopes(
            latest.effective.network,
            slot.ceiling.network,
          ),
          imports: intersectScopes(
            latest.effective.imports,
            slot.ceiling.imports,
          ),
        }
        : latest.effective;
      slot.source = latest.source;
      slot.policy = {
        ...latest,
        effective,
        fingerprint: permissionFingerprint(
          effective.network,
          effective.imports,
        ),
      };
      this.#sameDefinition(manifest);
      const redact = driverRedactor(this.#secrets.values(slot.instance.id));
      const worker = new DriverWorker(
        manifest,
        {
          id: slot.instance.id,
          label: slot.instance.label,
          settings: projectPageValues(
            driverSettingsPage(manifest.driver!.settings),
            slot.instance.settings,
          ),
        },
        hub.root,
        {
          current: () => this.#current(slot),
          effective,
          source: latest.source,
          secret: (key) => this.#secrets.get(slot.instance.id, key),
          hint: () => {
            if (this.#current(slot)) slot.nextFull = this.#clock.now();
          },
          failed: (detail) => {
            if (!this.#current(slot)) return;
            slot.view = this.#state("failed", redact(detail));
            // Failure accounting runs after any lost invocation outcome settles.
            slot.nextRetry = this.#clock.now() +
              Math.min(5000 * 2 ** slot.attempts++, 300_000);
            this.#changed();
          },
        },
      );
      slot.worker = worker;
      await worker.start();
      const ready = await plugins.network.policy(manifest.id);
      if (!this.#current(slot)) {
        worker.stop();
        return;
      }
      if (
        !equalSource(latest.source, ready.source) ||
        reduced(effective, ready.effective)
      ) {
        worker.stop();
        throw new PeerRevisionConflict();
      }
      this.#sameDefinition(manifest);
      slot.session = new DriverSession(
        slot.instance,
        manifest.driver!.capabilities,
        {
          hub,
          operations,
          driver: worker,
          current: () => this.#current(slot) && worker.current(),
          writable: () => lifecycle.writable(),
          redact,
          changed: () => this.#changed(),
        },
      );
    }
    await slot.session?.run(full);
  }
  revokeNetworkReduced(id: string, next: PermissionDeclaration): void {
    let changed = false;
    for (const slot of this.#slots.values()) {
      if (
        slot.retired || slot.instance.plugin !== id || !slot.policy ||
        !reduced(slot.policy.effective, next)
      ) continue;
      this.#retire(slot);
      slot.view = this.#state("failed", "network_denied");
      slot.nextRetry = this.#clock.now() +
        Math.min(5000 * 2 ** slot.attempts++, 300_000);
      changed = true;
    }
    if (changed) this.#changed();
  }
  captureSettingsRecovery(
    id: string,
    desired: NetworkPolicy,
  ): SettingsOwnerRecovery | undefined {
    const captured = [...this.#slots.values()].filter((slot) =>
      slot.instance.plugin === id && slot.source && slot.policy &&
      reduced(slot.policy.effective, desired.effective)
    );
    if (!captured.length) return undefined;
    let fenced = false;
    return {
      validate: () => {
        if (captured.some((slot) => !this.#current(slot))) {
          throw new PeerRevisionConflict();
        }
      },
      fence: () => {
        if (!fenced) {
          for (const slot of captured) this.#retire(slot);
          fenced = true;
        }
      },
      admit: async () => {
        if (!fenced || this.#closed) return;
        const latest = await this.adapters.plugins.network.policy(id);
        if (
          !equalSource(latest.source, desired.source) ||
          captured.some((slot) =>
            slot.source!.codeFingerprint !== desired.source.codeFingerprint
          )
        ) {
          throw new Error(
            "source-reload-required: driver settings recovery source changed",
          );
        }
        for (const slot of captured) {
          if (
            this.#slots.get(slot.instance.id) !== slot ||
            this.adapters.plugins.driverOwner(id).epoch !== slot.epoch ||
            this.adapters.lifecycle.epoch !== slot.access ||
            this.peers.instance(slot.instance.id)?.revision !==
              slot.instance.revision
          ) continue;
          const replacement = this.#newSlot(slot.instance, slot, desired);
          this.#run(replacement, true);
        }
      },
    };
  }
  async reloadNetwork(id: string, desired: NetworkPolicy): Promise<void> {
    const latest = await this.adapters.plugins.network.policy(id);
    if (
      !equalSource(latest.source, desired.source) ||
      latest.fingerprint !== desired.fingerprint
    ) throw new PeerRevisionConflict();
    for (const slot of this.#slots.values()) {
      if (slot.instance.plugin !== id) continue;
      if (
        slot.policy && equalSource(slot.policy.source, desired.source) &&
        slot.policy.fingerprint === desired.fingerprint &&
        slot.worker?.current()
      ) continue;
      this.#retire(slot);
      this.#newSlot(slot.instance, slot, desired);
    }
    await this.reconcile();
  }
  async view() {
    const catalog = await this.adapters.plugins.catalog();
    if (this.#closed) throw new HttpError(503, "Sync is unavailable");
    const vault = Deno.realPathSync(this.adapters.hub.root),
      state = Deno.realPathSync(this.adapters.hub.stateRoot);
    const relative = path.relative(vault, state);
    return {
      revision: this.#revision,
      notice: relative === "" ||
          !relative.startsWith("..") && !path.isAbsolute(relative)
        ? `Keys are stored in ${state}; tools that copy the whole vault folder copy them too.`
        : null,
      plugins: catalog.plugins.filter((plugin) =>
        plugin.enabled && plugin.driver
      ).map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        driver: plugin.driver,
      })),
      instances: this.peers.instances().map((instance) => {
        const plugin = catalog.plugins.find((plugin) =>
          plugin.id === instance.plugin
        );
        const slot = this.#slots.get(instance.id);
        const view =
          slot && !slot.retired && (!slot.worker || slot.worker.current())
            ? slot.session?.snapshot() ?? slot.view
            : slot?.view ??
              {
                status: "off",
                reason: null,
                error: null,
                lastSync: null,
                attention: null,
              };
        const redact = driverRedactor(this.#secrets.values(instance.id));
        // Redact the complete projection as well as session diagnostics: all native strings cross this boundary.
        const stateView = JSON.parse(
          JSON.stringify(
            view,
            (_key, value) => typeof value === "string" ? redact(value) : value,
          ),
        );
        return {
          ...instance,
          settings: plugin?.driver
            ? projectPageValues(
              driverSettingsPage(plugin.driver.settings),
              instance.settings,
            )
            : {},
          pluginName: plugin?.name ?? instance.plugin,
          declaration: plugin?.driver ?? null,
          secrets: this.#secrets.status(
            instance.id,
            plugin?.driver?.secrets ?? [],
          ),
          ...stateView,
          failingSince: instance.enabled
            ? this.peers.failingSince(instance.id)
            : null,
          activity: slot && !slot.retired ? slot.activity : null,
          nextRetry: slot && Number.isFinite(slot.nextRetry)
            ? Math.max(0, slot.nextRetry - this.#clock.now())
            : null,
          permissionsPage: view.reason === "network_denied" ||
              view.error?.code === "network_denied"
            ? `core:plugin-permissions:${instance.plugin}`
            : null,
        };
      }),
    };
  }
  async create(input: unknown, guard: () => void) {
    const raw = envelope(input, ["plugin", "label", "settings"]);
    if (typeof raw.plugin !== "string" || typeof raw.label !== "string") {
      throw new TypeError("Invalid sync instance");
    }
    const definition = this.#definition(raw.plugin, true);
    const settings = effectivePageValues(
      driverSettingsPage(definition.driver!.settings),
      raw.settings ?? {},
    );
    const instance = await this.adapters.lifecycle.gate.run(() => {
      guard();
      this.#assertOpen();
      this.#sameDefinition(definition);
      return this.peers.create(definition.id, raw.label as string, settings);
    });
    await this.reconcile();
    return { id: instance.id, revision: instance.revision };
  }
  #assertOpen(): void {
    if (this.#closed) throw new HttpError(503, "Sync is unavailable");
  }
  #sameDefinition(expected: PluginManifest): void {
    const actual = this.#definition(expected.id);
    if (
      actual.dir !== expected.dir ||
      JSON.stringify(actual.driver) !== JSON.stringify(expected.driver)
    ) {
      throw new PeerRevisionConflict();
    }
  }
  async update(id: string, input: unknown, guard: () => void) {
    const raw = envelope(input, ["revision", "label", "settings", "enabled"]);
    revision(raw.revision);
    const before = this.#instance(id, raw.revision as number);
    if (typeof raw.label !== "string" || typeof raw.enabled !== "boolean") {
      throw new TypeError("Invalid sync instance");
    }
    const definition = this.#definition(before.plugin);
    const values = effectivePageValues(
      driverSettingsPage(definition.driver!.settings),
      raw.settings,
    );
    const instance = await this.adapters.lifecycle.gate.run(() => {
      guard();
      this.#assertOpen();
      this.#sameDefinition(definition);
      const result = this.peers.update(id, before.revision, {
        label: raw.label as string,
        enabled: raw.enabled as boolean,
        settings: { ...before.settings, ...values },
      });
      const old = this.#slots.get(id);
      if (old) this.#retire(old);
      this.#slots.delete(id);
      return result;
    });
    await this.reconcile();
    return { id, revision: instance.revision };
  }
  async remove(id: string, input: unknown, guard: () => void) {
    const raw = envelope(input, ["revision"]);
    revision(raw.revision);
    await this.adapters.lifecycle.gate.run(() => {
      guard();
      this.#assertOpen();
      const instance = this.#instance(id, raw.revision as number);
      this.peers.retire(id, instance.revision);
      const slot = this.#slots.get(id);
      if (slot) this.#retire(slot);
      this.#slots.delete(id);
      this.#secrets.remove(id);
      this.#changed();
    });
    return { id, removed: true };
  }
  async secret(
    id: string,
    key: string,
    input: unknown,
    clear: boolean,
    guard: () => void,
  ) {
    const raw = envelope(input, clear ? ["revision"] : ["revision", "value"]);
    revision(raw.revision);
    const before = this.#instance(id, raw.revision as number),
      definition = this.#definition(before.plugin);
    if (!definition.driver!.secrets.some((item) => item.key === key)) {
      throw new HttpError(404, "Not Found");
    }
    if (
      !clear &&
      (typeof raw.value !== "string" || !raw.value ||
        new TextEncoder().encode(raw.value).length > 64 * 1024)
    ) throw new TypeError("Invalid driver key");
    const instance = await this.adapters.lifecycle.gate.run(() => {
      guard();
      this.#assertOpen();
      this.#sameDefinition(definition);
      this.#instance(id, before.revision);
      if (clear) this.#secrets.clear(id, key);
      else this.#secrets.set(id, key, raw.value as string);
      const result = this.peers.update(id, before.revision, before);
      const slot = this.#slots.get(id);
      if (slot) this.#retire(slot);
      this.#slots.delete(id);
      return result;
    });
    await this.reconcile();
    return {
      id,
      revision: instance.revision,
      secrets: this.#secrets.status(id, definition.driver!.secrets),
    };
  }
  async sync(id: string, input: unknown, guard: () => void) {
    const raw = envelope(input, ["revision"]);
    revision(raw.revision);
    guard();
    this.#assertOpen();
    const instance = this.#instance(id, raw.revision as number);
    let slot = this.#slots.get(id);
    if (!instance.enabled) throw new PeerRevisionConflict();
    if (slot && ["locked", "failed"].includes(slot.view.status)) {
      this.#retire(slot);
      slot = this.#newSlot(instance, slot);
    }
    if (!slot) {
      await this.reconcile();
      slot = this.#slots.get(id);
    }
    guard();
    this.#instance(id, raw.revision as number);
    if (slot) await this.#run(slot, true);
    return { id, revision: instance.revision };
  }
  async decide(id: string, input: unknown, guard: () => void) {
    const raw = envelope(input, [
      "instanceRevision",
      "attentionRevision",
      "action",
      "paths",
    ]);
    revision(raw.instanceRevision);
    revision(raw.attentionRevision);
    if (
      ![
        "held_restore",
        "held_delete",
        "remote_empty_delete",
        "remote_empty_upload",
      ].includes(raw.action as string) ||
      raw.paths !== undefined &&
        (!Array.isArray(raw.paths) ||
          raw.paths.some((value) => typeof value !== "string"))
    ) throw new TypeError("Invalid sync decision");
    guard();
    this.#assertOpen();
    this.#instance(id, raw.instanceRevision as number);
    const slot = this.#slots.get(id);
    if (!slot?.session || !this.#current(slot)) {
      throw new PeerRevisionConflict();
    }
    await slot.session.decide(raw as DriverDecision, guard);
    this.#changed();
    return { id, revision: slot.instance.revision };
  }
  async settle(): Promise<void> {
    await Promise.all([...this.#slots.values()].map(async (slot) => {
      await slot.pending;
      await slot.session?.settle();
    }));
    await Promise.all([...this.#retirements]);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#off) off();
    for (const slot of this.#slots.values()) this.#retire(slot);
    await this.settle();
    this.#listeners.clear();
    this.#secrets.close();
  }
}
function reduced(
  old: PermissionDeclaration,
  next: PermissionDeclaration,
): boolean {
  return (["network", "imports"] as const).some((kind) =>
    old[kind].some((scope) => !scopesCover(next[kind], scope))
  );
}
function envelope(input: unknown, keys: string[]): JsonValues {
  const raw = record(input, "sync controls");
  if (Object.keys(raw).some((key) => !keys.includes(key))) {
    throw new TypeError("Unsupported sync control");
  }
  return raw as JsonValues;
}
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PluginContractError(
      428,
      "driver_revision_required",
      "Read the sync instance before changing it.",
    );
  }
}
