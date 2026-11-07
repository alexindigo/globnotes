// SPDX-License-Identifier: LGPL-3.0-only

/** Authoritative service lifetimes, independent of rendering and browser login. */
import {
  type CommandDefinition,
  type EndpointDescriptor,
  FsError,
  type HandlerRegistration,
  type HookName,
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_LIMITS,
  PluginContractError,
  type PluginDiagnostic,
  type PluginLimits,
  type PluginStatus,
} from "./contracts.ts";
import { PluginDataStore } from "./data.ts";
import type { DisplacementOffer, Versioning } from "../hub/versioning.ts";
import { readGrantCovers } from "./lifecycle.ts";
import { PluginHost, type RpcAuthority } from "./host.ts";
import { processClock } from "../observed_time.ts";
import type { PluginManifest } from "./manifest.ts";
import type {
  NetworkPolicy,
  PluginNetworkRequests,
  SettingsOwnerRecovery,
} from "./network_requests.ts";
import {
  equalSource,
  intersectScopes,
  type PermissionDeclaration,
  scopesCover,
  type Source,
} from "./network_contracts.ts";
import { permissionFingerprint } from "./network_permissions.ts";
import type { PluginSettingsEnvironment } from "./settings_environment.ts";
import {
  type DiscoverRequest,
  type DiscoveryPage,
  DRIVER_LIMITS,
  DriverContractError,
  type DriverInstanceSnapshot,
  type DriverMethod,
  driverPath,
  type ExportItem,
  type MutationResult,
  type OpenResult,
  type ReadRequest,
  type ReadResult,
  validateDiscoveryPage,
  validateExportItems,
  validateMutationResults,
  validateOpenResult,
  validateReadResult,
} from "./driver_contract.ts";

export interface RuntimeSource {
  id: string;
  enabled: boolean;
  manifest?: PluginManifest;
  hooks: HookName[];
  diagnostic?: PluginDiagnostic;
}
export interface RuntimeAdapters {
  vaultPath: string;
  statePath: string;
  operational(): boolean;
  writable(): boolean;
  commit<T>(effect: () => Promise<T>): Promise<T>;
  /** Notes/files/actions are injected by the operation bundle, never raw state. */
  rpc?(
    manifest: PluginManifest,
    method: string,
    args: unknown[],
    authority: RpcAuthority,
  ): Promise<unknown>;
  /** Apply plugin read grants before disclosing fact snapshot contents. */
  sanitizeFact?(manifest: PluginManifest, fact: unknown): unknown;
  changed?(): void;
  network?: PluginNetworkRequests;
  settingsEnvironment?: PluginSettingsEnvironment;
  ownerEpoch?(id: string): number;
  ownerEnabled?(id: string): boolean;
}
interface RuntimeEntry {
  source: RuntimeSource;
  status: PluginStatus;
  host: PluginHost | null;
  starting: Promise<void> | null;
  diagnostics: PluginDiagnostic[];
  deliveryFailures: number;
  activation?: object;
  sourceToken?: Source;
  recoveryAdmission?: NetworkPolicy;
}
export interface GuardLease {
  pluginId: string;
  hook: HookName;
  generation: string;
  handlers: string[];
}
export class PluginGuardError extends PluginContractError {
  constructor(
    readonly pluginId: string,
    readonly hook: HookName,
    detail: string,
    readonly cancelled = false,
  ) {
    super(
      cancelled ? 409 : 503,
      cancelled ? "plugin_cancelled" : "plugin_guard_failed",
      detail,
    );
  }
}

export class PluginRuntime implements Versioning {
  private readonly entries = new Map<string, RuntimeEntry>();
  private order: string[] = [];
  private closed = false;
  private reconciliation = Promise.resolve();
  private catalogVersion = 0;
  private readonly retirements = new Set<Promise<void>>();
  readonly limits: PluginLimits;

  /** Bumped on every registration/status change; endpoint matchers and
   * catalog consumers cache against it. */
  get version(): number {
    return this.catalogVersion;
  }
  isEnabled(id: string): boolean {
    const entry = this.entries.get(id);
    return !!entry?.source.enabled && entry.status === "ready";
  }

  constructor(
    private readonly inventory: () => RuntimeSource[],
    private readonly adapters: RuntimeAdapters,
    limits: Partial<PluginLimits> = {},
  ) {
    this.limits = { ...PLUGIN_LIMITS, ...limits };
  }
  private changed() {
    this.catalogVersion++;
    this.adapters.changed?.();
  }
  private diagnostic(
    entry: RuntimeEntry,
    code: string,
    detail: string,
    correlation: { operationId?: string; action?: string } = {},
  ) {
    entry.diagnostics.push({ code, detail, ...correlation });
    if (entry.diagnostics.length > 256) entry.diagnostics.shift();
    this.changed();
  }
  /** Returns after admission; an on-only activation cannot delay the host. */
  reconcile(): Promise<void> {
    const next = this.reconciliation.catch(() => undefined).then(async () => {
      if (this.closed) return;
      const sources = this.inventory();
      // Publish a complete roster before any asynchronous retirement. Hooks,
      // guards and status readers can run while reconciliation awaits cleanup.
      for (const source of sources) {
        if (!this.entries.has(source.id)) {
          this.entries.set(source.id, {
            source,
            status: "discovered",
            host: null,
            starting: null,
            diagnostics: [],
            deliveryFailures: 0,
          });
        }
      }
      this.order = sources.map((source) => source.id);
      const present = new Set(this.order);
      for (const [id, entry] of this.entries) {
        if (!present.has(id)) {
          entry.source = { ...entry.source, enabled: false };
          await this.unload(entry);
        }
      }
      for (const source of sources) {
        const entry = this.entries.get(source.id)!;
        // An invalid code update cannot erase already-known required protection.
        const previousHooks = entry.source.hooks;
        entry.source = !source.manifest && source.enabled
          ? {
            ...source,
            hooks: [...new Set([...source.hooks, ...previousHooks])],
          }
          : source;
        if (!source.enabled || !this.adapters.operational()) {
          await this.unload(entry);
          entry.status = source.enabled ? "discovered" : "disabled";
          continue;
        }
        if (!source.manifest) {
          await this.unload(entry);
          entry.status = "failed";
          if (source.diagnostic) {
            this.diagnostic(
              entry,
              source.diagnostic.code,
              source.diagnostic.detail,
            );
          }
          continue;
        }
        if (!source.manifest.runtime.server && !source.manifest.hasEndpoints) {
          entry.status = "ready";
          continue;
        }
        if ((entry.host || entry.starting) && entry.status !== "failed") {
          continue;
        }
        if (entry.host) await this.unload(entry);
        this.activate(entry, source.manifest);
      }
      this.changed();
    });
    this.reconciliation = next;
    return next;
  }
  private activate(
    entry: RuntimeEntry,
    manifest: PluginManifest,
    recovery?: NetworkPolicy,
  ) {
    entry.status = "starting";
    const activation = {};
    entry.activation = activation;
    entry.recoveryAdmission = recovery;
    const epoch = this.adapters.ownerEpoch?.(manifest.id);
    const currentActivation = () =>
      entry.activation === activation && entry.source.enabled && !this.closed &&
      this.adapters.ownerEpoch?.(manifest.id) === epoch &&
      this.adapters.ownerEnabled?.(manifest.id) !== false;
    let candidate: PluginHost | null = null;
    entry.starting = (async () => {
      let policy = await this.adapters.network?.policy(manifest.id);
      if (!currentActivation()) return;
      if (this.adapters.network) {
        const latest = await this.adapters.network.policy(manifest.id);
        if (!currentActivation()) return;
        if (
          latest.source.codeFingerprint !== policy!.source.codeFingerprint
        ) {
          throw new Error(
            "service desired source/permissions changed before construction",
          );
        }
        policy = latest;
        if (recovery) {
          if (!equalSource(latest.source, recovery.source)) {
            throw new Error(
              "settings recovery source changed before construction",
            );
          }
          const effective = {
            network: intersectScopes(
              latest.effective.network,
              recovery.effective.network,
            ),
            imports: intersectScopes(
              latest.effective.imports,
              recovery.effective.imports,
            ),
          };
          policy = {
            ...latest,
            effective,
            fingerprint: permissionFingerprint(
              effective.network,
              effective.imports,
            ),
          };
        }
        const installed = this.inventory().find((source) =>
          source.id === manifest.id
        )?.manifest;
        if (!installed) {
          throw new Error("service installed source is unavailable");
        }
        manifest = installed;
      }
      const host: PluginHost = new PluginHost(
        manifest,
        this.adapters.vaultPath,
        (method, args, authority): Promise<unknown> => {
          if (!authority) {
            return Promise.reject(
              new Error("plugin authority is missing"),
            );
          }
          const current = (): boolean =>
            entry.host === host &&
            ["starting", "ready"].includes(entry.status) &&
            currentActivation() && authority.current();
          const generationCurrent = () =>
            entry.host === host &&
            ["starting", "ready"].includes(entry.status) &&
            currentActivation() && authority.generationCurrent();
          const bound: RpcAuthority = {
            ...authority,
            current,
            generationCurrent,
          };
          if (!current() || !this.adapters.operational()) {
            return Promise.reject(
              method.startsWith("fs.")
                ? new FsError(current() ? "fs_denied" : "fs_generation_revoked")
                : new Error("plugin authority is unavailable"),
            );
          }
          if (method.startsWith("permissions.")) {
            return this.adapters.network?.rpc(
              manifest.id,
              method,
              args,
              bound,
            ) ??
              Promise.reject(
                new Error("permission request service is unavailable"),
              );
          }
          const assertWriteCurrent = () => {
            if (
              !current() || !this.adapters.operational() ||
              !this.adapters.writable()
            ) {
              throw new Error("plugin write authority revoked");
            }
          };
          const store = new PluginDataStore(this.adapters.statePath, {
            settingsEnvironment: this.adapters.settingsEnvironment,
            settingsContext: this.adapters.network
              ? (id) => this.adapters.network!.settingsContext(id)
              : undefined,
            settingsSchema: (id) => {
              if (this.adapters.network) {
                return this.adapters.network.settingsSchema(id);
              }
              const source = this.inventory().find((candidate) =>
                candidate.id === id
              );
              if (!source?.manifest) {
                throw new PluginContractError(
                  409,
                  "plugin_settings_schema_conflict",
                  "plugin settings source is no longer available",
                );
              }
              return source.manifest.settings;
            },
            commit: (effect) =>
              this.adapters.commit(async () => {
                if (
                  !current() || !this.adapters.operational() ||
                  !this.adapters.writable()
                ) throw new Error("plugin write authority revoked");
                return await effect();
              }),
          }).forPlugin(manifest.id, undefined, assertWriteCurrent);
          if (method === "data.load") return store.load();
          if (method === "settings.read") {
            return store.settings(
              manifest.settings,
            );
          }
          if (method === "data.save") {
            if (!this.adapters.writable()) {
              return Promise.reject(
                new Error("vault is read-only"),
              );
            }
            return store.save(args[0], args[1] as number);
          }
          if (method === "diagnostic") {
            this.diagnostic(
              entry,
              "plugin_resource_failed",
              "managed plugin resource failed",
            );
            return Promise.resolve(null);
          }
          if (method === "actions.request" || method === "files.requestWrite") {
            if (authority.pre) {
              return Promise.reject(
                new Error(
                  "mutating action requests are forbidden during a pre-hook",
                ),
              );
            }
            if (!this.adapters.writable()) {
              return Promise.reject(
                new Error("vault is read-only"),
              );
            }
          }
          return this.adapters.rpc?.(manifest, method, args, bound) ??
            Promise.reject(
              new Error(`host service '${method}' is not available`),
            );
        },
        1,
        {
          role: "service",
          writable: this.adapters.writable(),
          limits: this.limits,
          snapshot: {
            pluginId: manifest.id,
            contractVersion: PLUGIN_CONTRACT_VERSION,
          },
          effective: policy?.effective,
          source: policy?.source,
          registrationChanged: () => this.changed(),
          failed: () => {
            if (entry.host !== host || !currentActivation()) return;
            entry.status = "failed";
            this.diagnostic(
              entry,
              "plugin_runtime_failed",
              "worker failed; in-flight side effects may be unknown",
            );
          },
        },
      );
      candidate = host;
      entry.host = host;
      entry.sourceToken = policy?.source;
      await host.start();
      if (entry.host !== host || !currentActivation()) {
        host.stop();
        return;
      }
      if (this.adapters.network) {
        const latest = await this.adapters.network.policy(manifest.id);
        if (entry.host !== host || !currentActivation()) {
          host.stop();
          return;
        }
        if (latest.source.codeFingerprint !== policy!.source.codeFingerprint) {
          throw new Error(
            "service installed code changed before ready publication",
          );
        }
        if (
          ["network", "imports"].some((kind) =>
            host.delegated[kind as keyof PermissionDeclaration].some((scope) =>
              !scopesCover(
                latest.effective[kind as keyof PermissionDeclaration],
                scope,
              )
            )
          )
        ) {
          throw new Error(
            "service delegated authority changed before ready publication",
          );
        }
      }
      if (!host.available) {
        throw new Error(
          "service Worker became unavailable before ready publication",
        );
      }
      entry.status = "ready";
      entry.recoveryAdmission = undefined;
      this.changed();
    })().catch((error) => {
      candidate?.stop();
      if (!currentActivation()) return;
      if (entry.host === candidate) entry.host = null;
      entry.starting = null;
      entry.sourceToken = undefined;
      entry.recoveryAdmission = undefined;
      entry.status = "failed";
      this.diagnostic(
        entry,
        "plugin_activation_failed",
        error instanceof Error ? error.message : "activation failed",
      );
    });
  }
  ownerIds(): string[] {
    return [...this.entries.keys()];
  }
  ownerSource(id: string): Source | undefined {
    const entry = this.entries.get(id);
    return entry?.sourceToken ?? entry?.recoveryAdmission?.source;
  }
  /** Capture the actual same-code owner before reduction clears its host. */
  captureSettingsRecovery(
    id: string,
    desired: NetworkPolicy,
  ): SettingsOwnerRecovery | undefined {
    const entry = this.entries.get(id);
    const oldSource = entry?.sourceToken ?? entry?.recoveryAdmission?.source;
    const oldRights = entry?.host?.delegated ??
      entry?.recoveryAdmission?.effective;
    if (
      !entry || !oldSource || !oldRights ||
      (!entry.recoveryAdmission &&
        ["network", "imports"].every((kind) =>
          oldRights[kind as keyof PermissionDeclaration].every((scope) =>
            scopesCover(
              desired.effective[kind as keyof PermissionDeclaration],
              scope,
            )
          )
        ))
    ) return undefined;
    const host = entry.host,
      activation = entry.activation,
      epoch = this.adapters.ownerEpoch?.(id);
    let fenced = false, retired: object | undefined;
    return {
      validate: () => {
        if (
          this.entries.get(id) !== entry || entry.host !== host ||
          entry.activation !== activation ||
          this.adapters.ownerEpoch?.(id) !== epoch
        ) {
          throw new PluginContractError(
            409,
            "permission_source_conflict",
            "service owner changed before settings effect",
          );
        }
      },
      fence: () => {
        if (fenced) return;
        if (
          this.entries.get(id) !== entry || entry.host !== host ||
          entry.activation !== activation ||
          this.adapters.ownerEpoch?.(id) !== epoch
        ) return;
        this.retireOwner(id, undefined, true);
        fenced = true;
        retired = entry.activation;
      },
      admit: async () => {
        if (
          !fenced || this.closed || entry.activation !== retired ||
          entry.host || !entry.source.enabled ||
          this.adapters.ownerEpoch?.(id) !== epoch ||
          this.adapters.ownerEnabled?.(id) === false
        ) return;
        if (oldSource.codeFingerprint !== desired.source.codeFingerprint) {
          throw new Error(
            "source-reload-required: settings recovery cannot consume changed installed service code",
          );
        }
        const latest = await this.adapters.network?.policy(id);
        if (!latest || !equalSource(latest.source, desired.source)) {
          throw new Error(
            latest &&
              latest.source.codeFingerprint !== desired.source.codeFingerprint
              ? "source-reload-required: installed service code changed during settings recovery"
              : "settings recovery source is no longer current",
          );
        }
        if (
          this.closed || entry.activation !== retired || entry.host ||
          !entry.source.enabled || this.adapters.ownerEpoch?.(id) !== epoch ||
          this.adapters.ownerEnabled?.(id) === false
        ) return;
        const manifest = this.inventory().find((source) => source.id === id)
          ?.manifest;
        if (!manifest) {
          throw new Error("settings recovery service source is unavailable");
        }
        const rights = {
          network: intersectScopes(
            latest.effective.network,
            desired.effective.network,
          ),
          imports: intersectScopes(
            latest.effective.imports,
            desired.effective.imports,
          ),
        };
        this.activate(entry, manifest, {
          source: desired.source,
          effective: rights,
          fingerprint: permissionFingerprint(rights.network, rights.imports),
        });
      },
    };
  }
  /** Detaches current admission synchronously; only the captured owner is disposed. */
  retireOwner(id: string, enabled?: boolean, immediate = false): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (enabled !== undefined) entry.source = { ...entry.source, enabled };
    const host = entry.host;
    entry.host = null; // Revoke authority before draining or disposal.
    const retirement = {};
    entry.activation = retirement;
    entry.starting = null;
    entry.sourceToken = undefined;
    entry.recoveryAdmission = undefined;
    entry.status = entry.source.enabled ? "discovered" : "disabled";
    this.changed();
    if (!host) return Promise.resolve();
    if (immediate) {
      host.stop();
      return Promise.resolve();
    }
    const completion = host.dispose().then((result) => {
      if (entry.activation !== retirement || entry.host !== null) return;
      if (result.unfinished || result.errors.length) {
        this.diagnostic(
          entry,
          "plugin_disposal_incomplete",
          `${result.unfinished} unfinished jobs; ${result.errors.length} disposal errors`,
        );
      }
      entry.status = entry.source.enabled ? "discovered" : "disabled";
    });
    this.retirements.add(completion);
    completion.then(
      () => this.retirements.delete(completion),
      () => this.retirements.delete(completion),
    );
    return completion;
  }
  private unload(entry: RuntimeEntry): Promise<void> {
    return this.retireOwner(entry.source.id);
  }
  status(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return {
      status: entry.status,
      generation: entry.host?.generation ?? null,
      delegated: entry.host?.delegated ?? null,
      degraded: entry.deliveryFailures > 0,
      deliveryFailures: entry.deliveryFailures,
      diagnostics: structuredClone(entry.diagnostics),
      ...(entry.source.manifest?.versioning
        ? { versioningPending: entry.host?.versioningPending ?? 0 }
        : {}),
    };
  }
  /** Losing any delegated scope terminates raw authority synchronously. */
  revokeNetworkReduced(id: string, next: PermissionDeclaration): void {
    const entry = this.entries.get(id), old = entry?.host?.delegated;
    if (
      !entry?.host || !old ||
      ["network", "imports"].every((kind) =>
        old[kind as keyof PermissionDeclaration].every((scope) =>
          scopesCover(next[kind as keyof PermissionDeclaration], scope)
        )
      )
    ) return;
    this.retireOwner(id, undefined, true);
    this.diagnostic(
      entry,
      "permission_generation_revoked",
      "server permissions reduced; old generation terminated and unfinished work is not replayed",
    );
  }
  async reloadNetwork(
    id: string,
    desired: PermissionDeclaration,
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (
      !entry?.source.enabled || !entry.source.manifest ||
      !this.adapters.operational() ||
      (!entry.source.manifest.runtime.server &&
        !entry.source.manifest.hasEndpoints)
    ) return;
    const current = entry.host?.delegated;
    if (
      entry.status === "ready" && current &&
      permissionFingerprint(current.network, current.imports) ===
        permissionFingerprint(desired.network, desired.imports)
    ) return;
    const epoch = this.adapters.ownerEpoch?.(id);
    this.retireOwner(id, undefined, true);
    if (
      this.adapters.ownerEpoch?.(id) !== epoch ||
      this.adapters.ownerEnabled?.(id) === false || !entry.source.enabled
    ) return;
    this.activate(entry, entry.source.manifest);
    const starting = entry.starting, activation = entry.activation;
    await starting;
    if (entry.activation !== activation) return;
    if (entry.status !== "ready") {
      throw new PluginContractError(
        503,
        "permission_reload_failed",
        "affected service Worker did not become ready",
      );
    }
  }
  commands(): (CommandDefinition & { pluginId: string; fullId: string })[] {
    return this.order.flatMap((id) => {
      const entry = this.entries.get(id);
      if (
        !entry || entry.status !== "ready" || !entry.source.enabled ||
        !entry.host
      ) return [];
      return [...entry.host.registrations.values()].filter((r) =>
        r.kind === "command"
      ).map((r) => ({
        ...r.definition as CommandDefinition,
        pluginId: id,
        fullId: `plugin:${id}:${r.id}`,
      }));
    });
  }
  private handlerIds(
    entry: RuntimeEntry,
    kind: HandlerRegistration["kind"],
    id?: string,
  ) {
    return [...entry.host?.registrations ?? []].filter(([, registration]) =>
      registration.kind === kind && (id === undefined || registration.id === id)
    ).map(([handlerId]) => handlerId);
  }
  async invokeCommand(
    id: string,
    command: string,
    payload: unknown,
  ): Promise<unknown> {
    const entry = this.entries.get(id);
    if (
      !entry || !entry.source.enabled || entry.status !== "ready" || !entry.host
    ) throw new Error("plugin command unavailable");
    const handler = this.handlerIds(entry, "command", command)[0];
    if (!handler) throw new Error("plugin command is not registered");
    return await entry.host.invoke(handler, [payload]);
  }

  /** Endpoint descriptors reported by the owning worker (handlerId +
   * serializable descriptor); compiled by the sandbox endpoint router. */
  endpointDescriptors(
    id: string,
  ): { handlerId: string; descriptor: EndpointDescriptor }[] {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "ready" || !entry.host) return [];
    return [...entry.host.registrations]
      .filter(([, r]) => r.kind === "endpoint" && r.definition)
      .map(([handlerId, r]) => ({
        handlerId,
        descriptor: r.definition as EndpointDescriptor,
      }));
  }

  /** Generic registered-handler invocation (endpoints). The guard lane is
   * for pre-hooks only; endpoint calls use the FIFO service lane. */
  async invokeHandler(
    id: string,
    handlerId: string,
    args: unknown[],
  ): Promise<unknown> {
    const entry = this.entries.get(id);
    if (
      !entry || !entry.source.enabled || entry.status !== "ready" || !entry.host
    ) throw new Error("plugin handler unavailable");
    return await entry.host.invoke(handlerId, args);
  }
  private async readyGuard(
    entry: RuntimeEntry,
    hook: HookName,
    deadline: number,
  ) {
    if (entry.starting && entry.status === "starting") {
      let cancel: (() => void) | undefined;
      try {
        await Promise.race([
          entry.starting,
          new Promise((_, reject) => {
            cancel = processClock.deadlineAt(
              deadline,
              () => reject(new Error("guard readiness deadline exceeded")),
            );
          }),
        ]);
      } finally {
        cancel?.();
      }
    }
    if (entry.status !== "ready" || !entry.host?.available) {
      throw new PluginGuardError(
        entry.source.id,
        hook,
        "required plugin guard is unavailable",
      );
    }
  }
  /** `operationDeadline` is in observed time (server/observed_time.ts). */
  async guard(
    hook: HookName,
    payload: unknown,
    operationDeadline = processClock.now() + this.limits.preOperationMs,
  ): Promise<GuardLease[]> {
    if (!hook.startsWith("pre-")) {
      throw new Error("guard requires a cancellable pre-hook");
    }
    const holding = processClock.hold();
    try {
      return await this.guardAll(hook, payload, operationDeadline);
    } finally {
      holding();
    }
  }
  private async guardAll(
    hook: HookName,
    payload: unknown,
    operationDeadline: number,
  ): Promise<GuardLease[]> {
    const leases: GuardLease[] = [];
    for (const id of this.order) {
      const entry = this.entries.get(id)!;
      if (!entry.source.enabled || !entry.source.hooks.includes(hook)) continue;
      const deadline = Math.min(
        operationDeadline,
        processClock.now() + this.limits.preHookMs,
      );
      try {
        await this.readyGuard(entry, hook, deadline);
        const host = entry.host!;
        const handlers = this.handlerIds(entry, "hook", hook);
        if (!handlers.length) throw new Error("required guard handler missing");
        const disclosed = entry.source.manifest && this.adapters.sanitizeFact
          ? this.adapters.sanitizeFact(entry.source.manifest, payload)
          : payload;
        for (const handler of handlers) {
          const remaining = deadline - processClock.now();
          if (remaining <= 0) throw new Error("guard deadline exceeded");
          const result = await host.invoke(
            handler,
            [disclosed],
            true,
            remaining,
            { generation: host.generation!, causal: operationCause(payload) },
          ) as { cancel?: boolean; reason?: unknown } | undefined;
          if (processClock.now() > deadline) {
            throw new Error("guard deadline exceeded before result delivery");
          }
          if (result?.cancel === true) {
            throw new PluginGuardError(
              id,
              hook,
              typeof result.reason === "string"
                ? result.reason
                : "plugin cancelled the operation",
              true,
            );
          }
        }
        leases.push({
          pluginId: id,
          hook,
          generation: host.generation!,
          handlers,
        });
      } catch (error) {
        if (error instanceof PluginGuardError) throw error;
        throw new PluginGuardError(
          id,
          hook,
          "required plugin guard failed or exceeded its deadline",
        );
      }
    }
    return leases;
  }
  assertGuardAuthority(hook: HookName, leases: GuardLease[]) {
    for (const id of this.order) {
      const entry = this.entries.get(id)!;
      if (!entry.source.enabled || !entry.source.hooks.includes(hook)) continue;
      const lease = leases.find((value) =>
        value.pluginId === id && value.hook === hook
      );
      if (
        !lease || entry.status !== "ready" || !entry.host?.available ||
        entry.host.generation !== lease.generation ||
        lease.handlers.some((handler) =>
          !entry.host!.registrations.has(handler)
        )
      ) {
        throw new PluginGuardError(
          id,
          hook,
          "required plugin guard authority changed before commit",
        );
      }
    }
  }
  /** A contract diagnostic for a plugin (e.g. a contract-1 write refused). */
  contractDiagnostic(
    id: string,
    code: string,
    detail: string,
    correlation: { operationId?: string; action?: string } = {},
  ): void {
    const entry = this.entries.get(id);
    if (entry) this.diagnostic(entry, code, detail, correlation);
  }
  /** Enabled plugins declaring `versioning`, in plugin order. */
  private versioners(): RuntimeEntry[] {
    return this.order.map((id) => this.entries.get(id)!).filter((entry) =>
      entry.source.enabled && entry.source.manifest?.versioning
    );
  }
  /** Versioning (server/hub/versioning.ts): whether a versioner takes offers
   * for `path`. Writes by a versioner are never offered, preventing recursive
   * versioning of plugin-maintained history. */
  interested(path: string, origin: string): boolean {
    const versioners = this.versioners();
    if (versioners.some((entry) => origin === `plugin:${entry.source.id}`)) {
      return false;
    }
    return versioners.some((entry) => this.versionerTakes(entry, path));
  }
  private versionerTakes(entry: RuntimeEntry, path: string): boolean {
    const manifest = entry.source.manifest!;
    const extensions = manifest.versioning?.extensions;
    const lower = path.toLowerCase();
    return (!extensions || extensions.some((ext) => lower.endsWith(ext))) &&
      readGrantCovers(
        manifest,
        this.adapters.vaultPath,
        this.adapters.statePath,
        path,
      );
  }
  /** Post-commit admission only. Each host owns a bounded FIFO and its ordinary
   * call deadline. No readiness, handler, filesystem RPC or result is awaited. */
  enqueue(offers: DisplacementOffer[]): void {
    if (this.closed) return;
    for (const entry of this.versioners()) {
      for (const offer of offers) {
        if (
          !this.interested(offer.path, offer.origin) ||
          !this.versionerTakes(entry, offer.path)
        ) continue;
        const failure = (code: string, detail: string) => {
          entry.deliveryFailures++;
          this.diagnostic(entry, code, detail, {
            operationId: offer.operationId,
            action: offer.kind,
          });
        };
        if (offer.bytes === null) {
          failure(
            "versioning_failed",
            "displaced file exceeds the offer bound; offered without bytes",
          );
        }
        const host = entry.host;
        const [handler] = this.handlerIds(entry, "versioning");
        if (entry.status !== "ready" || !host?.available || !handler) {
          failure(
            "versioning_gap",
            "versioning delivery unavailable; committed version was dropped",
          );
          continue;
        }
        host.invoke(handler, [offer], false, this.limits.serviceCallMs, {
          generation: host.generation!,
          causal: { parentId: offer.operationId, depth: 1 },
          lane: "versioning",
        }).catch((error) => {
          failure(
            error instanceof PluginContractError &&
              error.code === "plugin_versioning_gap"
              ? "versioning_gap"
              : "versioning_failed",
            String((error as Error)?.message ?? error),
          );
        });
      }
    }
  }
  /** Observer admission never waits for readiness or executes under an operation lock. */
  post(
    hook: HookName,
    payload: unknown,
    correlation: { operationId?: string; action?: string } = {},
    owner?: string,
    target?: {
      generation: string;
      causal: { parentId?: string; depth: number };
    },
  ) {
    if (hook.startsWith("pre-")) {
      throw new Error("pre-hooks require the guard coordinator");
    }
    for (const id of this.order) {
      const entry = this.entries.get(id)!;
      if (
        !entry.source.enabled || (owner && id !== owner) ||
        !entry.source.hooks.includes(hook)
      ) continue;
      if (target && entry.host?.generation !== target.generation) continue;
      const ids = this.handlerIds(entry, "hook", hook);
      if (entry.status !== "ready" || !entry.host?.available || !ids.length) {
        entry.deliveryFailures++;
        this.diagnostic(
          entry,
          "plugin_delivery_unavailable",
          "observer delivery was unavailable",
          correlation,
        );
        continue;
      }
      const disclosed = entry.source.manifest && this.adapters.sanitizeFact
        ? this.adapters.sanitizeFact(entry.source.manifest, payload)
        : payload;
      for (const handler of ids) {
        entry.host.invoke(
          handler,
          [disclosed],
          false,
          entry.host.limits.serviceCallMs,
          {
            generation: target?.generation ?? entry.host.generation!,
            causal: target?.causal ?? operationCause(payload),
          },
        ).catch(() => {
          entry.deliveryFailures++;
          this.diagnostic(
            entry,
            "plugin_delivery_failed",
            "observer delivery failed or its outcome is unknown",
            correlation,
          );
        });
      }
    }
  }
  private subscriptions(
    owner: string,
    kind: "settings-change" | "action-result",
    payload: unknown,
    target?: {
      generation: string;
      causal: { parentId?: string; depth: number };
    },
  ) {
    const entry = this.entries.get(owner);
    if (
      !entry?.source.enabled || entry.status !== "ready" ||
      !entry.host?.available
    ) return;
    if (target && entry.host.generation !== target.generation) return;
    for (const handler of this.handlerIds(entry, kind)) {
      entry.host.invoke(
        handler,
        [payload],
        false,
        entry.host.limits.serviceCallMs,
        {
          generation: target?.generation ?? entry.host.generation!,
          causal: target?.causal,
        },
      ).catch(() => {
        entry.deliveryFailures++;
        this.diagnostic(
          entry,
          "plugin_subscription_failed",
          "managed subscription delivery failed or its outcome is unknown",
        );
      });
    }
  }
  settingsChanged(owner: string, pageId: string, revision: number) {
    const event = { pluginId: owner, pageId, revision };
    this.post("on-settings-change", event, {}, owner);
    this.subscriptions(owner, "settings-change", event);
    this.changed();
  }
  actionResult(
    owner: string,
    generation: string,
    receipt: unknown,
    causal: { parentId?: string; depth: number },
  ) {
    const target = { generation, causal };
    this.post("on-action-result", receipt, {}, owner, target);
    this.subscriptions(owner, "action-result", receipt, target);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.reconciliation.catch(() => undefined);
    await Promise.all(
      [...this.entries.values()].map((entry) => this.unload(entry)),
    );
    await Promise.all([...this.retirements]);
  }
  /** Access transitions revoke old generations synchronously before config changes. */
  suspend(): void {
    for (const entry of this.entries.values()) {
      const host = entry.host;
      entry.host = null;
      entry.activation = undefined;
      entry.starting = null;
      host?.stop();
      if (host) {
        this.diagnostic(
          entry,
          "plugin_policy_revoked",
          "old generation revoked by an access-policy transition; unfinished work is not replayed",
        );
      }
      entry.status = entry.source.enabled ? "discovered" : "disabled";
    }
    this.changed();
  }
}

function operationCause(
  payload: unknown,
): { parentId?: string; depth: number } {
  const fact = payload as { operationId?: string; causalDepth?: number } | null;
  return {
    parentId: typeof fact?.operationId === "string"
      ? fact.operationId
      : undefined,
    depth: typeof fact?.causalDepth === "number" ? fact.causalDepth : 0,
  };
}

export interface DriverWorkerAdapters {
  /** Supervisor owns the instance/configuration/policy epoch. */
  current(): boolean;
  secret(key: string): string | null | Promise<string | null>;
  hint(): void;
  failed?(detail: string): void;
  effective?: PermissionDeclaration;
  source?: Source;
  /** Tests may shorten observed-time deadlines, never change production bounds. */
  deadlines?: Partial<Record<DriverMethod, number>>;
  hostLimits?: Partial<PluginLimits>;
}

/** One authoritative Worker for one instance. No vault service RPC is reachable
 * from this role; the instance is captured here, never selected by a message. */
export class DriverWorker {
  readonly host: PluginHost;
  private opened?: OpenResult;
  private opening?: Promise<OpenResult>;
  private started = false;
  private retired = false;
  constructor(
    readonly manifest: PluginManifest,
    instance: DriverInstanceSnapshot,
    vaultPath: string,
    private readonly adapters: DriverWorkerAdapters,
  ) {
    if (!manifest.driver) throw new Error("plugin has no driver contribution");
    this.host = new PluginHost(
      manifest,
      vaultPath,
      async (method, args, authority) => {
        const current = () => !!authority?.current() && this.current();
        if (
          !current() || authority?.role !== "driver" || !Array.isArray(args)
        ) {
          throw new Error("driver generation is unavailable");
        }
        if (method === "driver.secret") {
          const key = args[0];
          if (
            args.length !== 1 || typeof key !== "string" ||
            !manifest.driver!.secrets.some((secret) => secret.key === key)
          ) {
            throw new Error("driver secret is not declared");
          }
          const value = await adapters.secret(key);
          // A held lookup cannot disclose a key to a replaced instance generation.
          if (!current()) throw new Error("driver generation is unavailable");
          if (value !== null && typeof value !== "string") {
            throw new Error(
              "driver secret is unavailable",
            );
          }
          return value;
        }
        if (method === "driver.hint" && args.length === 0) {
          adapters.hint();
          return null;
        }
        throw new Error("driver RPC is not available");
      },
      1,
      {
        role: "driver",
        instance: structuredClone(instance),
        effective: adapters.effective,
        source: adapters.source,
        limits: adapters.hostLimits,
        failed: (detail) => {
          this.retired = true;
          adapters.failed?.(
            detail === "driver_contract_violation"
              ? detail
              : "driver Worker failed; in-flight outcome unknown",
          );
        },
      },
    );
  }
  current(): boolean {
    return !this.retired && this.adapters.current();
  }
  async start(): Promise<void> {
    if (this.started || !this.current()) {
      throw new Error("driver generation is unavailable");
    }
    this.started = true;
    await this.host.start();
    if (!this.current()) {
      this.stop();
      throw new Error("driver generation is unavailable");
    }
  }
  private async invoke(
    method: DriverMethod,
    args: unknown[],
  ): Promise<unknown> {
    if (!this.current() || !this.host.available) {
      throw new Error("driver generation is unavailable");
    }
    const handler = [...this.host.registrations].find(([, entry]) =>
      entry.kind === "driver" && entry.id === method
    )?.[0];
    if (!handler) throw new DriverContractError();
    const value = await this.host.invoke(
      handler,
      args,
      false,
      this.adapters.deadlines?.[method] ?? DRIVER_LIMITS[`${method}Ms`],
      { generation: this.host.generation! },
    );
    if (!this.current()) throw new Error("driver generation is unavailable");
    return value;
  }
  private validate<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      this.stop();
      this.adapters.failed?.("driver_contract_violation");
      throw error instanceof DriverContractError
        ? error
        : new DriverContractError();
    }
  }
  async open(): Promise<OpenResult> {
    if (!this.current() || !this.host.available) {
      throw new Error("driver generation is unavailable");
    }
    this.opening ??= this.invoke("open", []).then((value) => {
      this.opened = this.validate(() => validateOpenResult(value));
      return this.opened;
    });
    return structuredClone(await this.opening);
  }
  async discover(request: DiscoverRequest): Promise<DiscoveryPage> {
    const opened = this.opened;
    if (opened?.state !== "ready") {
      throw new Error("driver endpoint is not ready");
    }
    if (
      !request || !["snapshot", "delta"].includes(request.mode) ||
      Object.keys(request).some((key) => key !== "mode" && key !== "cursor") ||
      (request.cursor !== undefined && typeof request.cursor !== "string") ||
      (request.mode === "delta" &&
        !this.manifest.driver!.capabilities.discovery.delta)
    ) throw new DriverContractError();
    const captured = structuredClone(request);
    const value = await this.invoke("discover", [captured]);
    return this.validate(() =>
      validateDiscoveryPage(
        value,
        this.manifest.driver!.capabilities,
        captured,
        opened,
      )
    );
  }
  async read(request: ReadRequest): Promise<ReadResult> {
    if (this.opened?.state !== "ready") {
      throw new Error("driver endpoint is not ready");
    }
    driverPath(request.path);
    if (
      typeof request.revision !== "string" || !request.revision ||
      new TextEncoder().encode(request.revision).length > 512 ||
      Object.keys(request).some((key) => key !== "path" && key !== "revision")
    ) throw new DriverContractError();
    let value: unknown;
    try {
      value = await this.invoke("read", [structuredClone(request)]);
    } catch {
      return { state: "unknown", reason: "driver_read_unavailable" };
    }
    return this.validate(() =>
      validateReadResult(value, this.manifest.driver!.capabilities)
    );
  }
  async apply(items: ExportItem[]): Promise<MutationResult[]> {
    if (this.opened?.state !== "ready") {
      throw new Error("driver endpoint is not ready");
    }
    const captured = validateExportItems(
      items,
      this.manifest.driver!.capabilities,
    );
    let value: unknown;
    try {
      value = await this.invoke("apply", [captured]);
    } catch {
      // Lost reply/deadline/crash never proves the endpoint did not commit.
      return captured.map(({ id }) => ({ id, state: "uncertain" }));
    }
    return this.validate(() => validateMutationResults(value, captured));
  }
  async close(): Promise<void> {
    try {
      if (this.current() && this.host.available) {
        const value = await this.invoke("close", []);
        if (value !== undefined && value !== null) {
          this.validate(() => {
            throw new DriverContractError();
          });
        }
      }
    } finally {
      this.retired = true;
      await this.host.dispose();
    }
  }
  stop(): void {
    this.retired = true;
    this.host.stop();
  }
}
