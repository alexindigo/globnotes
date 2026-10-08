// SPDX-License-Identifier: LGPL-3.0-only

/** One catalog of optional contributions. Rendering is a lazy compatibility adapter. */
import * as path from "@std/path";
import { getEnv } from "../helpers.ts";
import { logger } from "../logger.ts";
import {
  PluginHost,
  type RenderRecoveryAdmission,
  type RpcAuthority,
  type RpcHandler,
} from "./host.ts";
import {
  discoverPluginDirs,
  pluginCodePath,
  type PluginManifest,
  readManifest,
} from "./manifest.ts";
import { renderPluginRpc } from "./rpc.ts";
import { PluginRuntime, type RuntimeAdapters } from "./runtime.ts";
import type { OperationFact, PluginLimits } from "./contracts.ts";
import {
  HOOK_NAMES,
  type HookName,
  PLUGIN_CONTRACT_VERSION,
  PluginContractError,
  type PluginDiagnostic,
  type PluginStatus,
} from "./contracts.ts";
import {
  type PersistenceAdapters,
  PluginDataStore,
  type PluginPolicy,
  PluginPolicyStore,
  policyEnables,
} from "./data.ts";
import {
  type NetworkPlugin,
  type NetworkPolicy,
  PluginNetworkRequests,
  type SettingsOwnerRecovery,
} from "./network_requests.ts";
import {
  equalSource,
  intersectScopes,
  type PermissionDeclaration,
  type PermissionView,
  scopesCover,
  type Source,
} from "./network_contracts.ts";
import { permissionFingerprint } from "./network_permissions.ts";

const INTERNAL_PLUGINS_DIR = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "../../plugins",
);
interface CatalogEntry {
  id: string;
  dir: string;
  manifest?: PluginManifest;
  diagnostic?: PluginDiagnostic;
  hooks?: HookName[];
}
interface RenderOwner {
  id: string;
  epoch: number;
  state: "starting" | "ready" | "failed" | "retired";
  host: PluginHost | null;
  source?: Source;
  fingerprint?: string;
  starting?: Promise<RenderStartOutcome>;
  cancel: ReturnType<typeof Promise.withResolvers<void>>;
  diagnostic?: PluginDiagnostic;
  recoveryAdmission?: NetworkPolicy;
}
export interface RenderOwnerLease {
  pluginId: string;
  epoch: number;
  host: PluginHost;
  generations: readonly string[];
  source?: Source;
}
export type RenderStartOutcome =
  | { state: "ready"; lease: RenderOwnerLease }
  | { state: "failed"; diagnostic: PluginDiagnostic }
  | { state: "retired" };
export interface PluginManagerOptions {
  internalRoot?: string;
  autoEnable?: boolean;
  environment?: boolean;
  persistence?: PersistenceAdapters;
  /** Evaluated at pool start/respawn: all worker roles get write:false
   * while setup is pending or the vault is read-only. */
  renderWritable?: () => boolean;
}
export class PluginManager {
  readonly hosts = new Map<string, PluginHost>();
  readonly policy: PluginPolicyStore;
  readonly network: PluginNetworkRequests;
  private readonly vaultPath: string;
  private readonly statePath: string;
  private readonly workerCount: number;
  private readonly rpc?: RpcHandler;
  private readonly renderRpc: ReturnType<typeof renderPluginRpc>;
  private readonly internalRoot: string;
  private readonly options: PluginManagerOptions;
  private startPromise: Promise<void> | null = null;
  private serviceRuntime: PluginRuntime | null = null;
  private syncBoundary: Promise<void> = Promise.resolve();
  private renderRequested = false;
  private readonly renderOwners = new Map<string, RenderOwner>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly seenEnabled = new Map<string, boolean>();
  private networkCommit: PersistenceAdapters["commit"];
  private networkChanged: () => void = () => {};
  private readonly retirements = new Set<Promise<void>>();

  constructor(
    vaultPath: string,
    rpc?: RpcHandler,
    workerCount?: number,
    statePath?: string,
    options: PluginManagerOptions = {},
  ) {
    this.vaultPath = vaultPath;
    this.statePath = statePath ?? path.join(vaultPath, ".globnotes");
    this.rpc = rpc;
    this.renderRpc = renderPluginRpc({
      vaultPath: this.vaultPath,
      statePath: this.statePath,
    });
    this.workerCount = workerCount ??
      Number(getEnv("GLOBNOTES_RENDER_WORKERS", { castInt: true, default: 2 }));
    this.internalRoot = options.internalRoot ?? INTERNAL_PLUGINS_DIR;
    this.options = options;
    this.networkCommit = (effect) =>
      options.persistence?.commit(effect) ??
        Promise.reject(
          new Error(
            "permission persistence requires the owning host commit adapter",
          ),
        );
    const statedDefault = getEnv("GLOBNOTES_AUTO_ENABLE_PLUGINS");
    this.policy = new PluginPolicyStore(
      this.statePath,
      {
        commit: (effect) =>
          this.networkCommit(async () => {
            const result = await effect();
            // Policy replacement has settled: retire both server roles before yielding again.
            this.retireUndesiredOwners();
            return result;
          }),
      },
      {
        autoEnable: options.autoEnable ?? true,
        environment: options.environment ??
          (statedDefault
            ? getEnv("GLOBNOTES_AUTO_ENABLE_PLUGINS", { castBool: true }) ===
              "true"
            : undefined),
      },
    );
    this.network = new PluginNetworkRequests(this.statePath, {
      commit: (effect) => this.networkCommit(effect),
      plugins: () => this.networkPlugins(),
      changed: () => this.networkChanged(),
      revokeReduced: (id, effective) => this.revokeReduced(id, effective),
      reload: (id, policy) => this.reloadPermissions(id, policy),
      sourceDurable: () => !!this.options.persistence || !!this.serviceRuntime,
      activeSources: (id) => {
        const render = this.renderOwners.get(id),
          service = this.serviceRuntime?.ownerSource(id);
        return [
          ...render?.source && ["starting", "ready"].includes(render.state)
            ? [render.source]
            : [],
          ...service ? [service] : [],
        ];
      },
      captureSettingsRecovery: (id, policy) =>
        this.captureSettingsRecovery(id, policy),
    });
  }

  /** Invalid overrides remain visible failures; they never select an older implementation. */
  private inventory(
    policy: PluginPolicy = this.policy.selection().policy,
  ): CatalogEntry[] {
    const entries = new Map<string, CatalogEntry>();
    for (
      const root of [this.internalRoot, path.join(this.statePath, "plugins")]
    ) {
      for (const dir of discoverPluginDirs(root)) {
        const id = path.basename(dir);
        try {
          entries.set(id, { id, dir, manifest: readManifest(dir) });
        } catch (error) {
          const detail = error instanceof Error
            ? error.message
            : "invalid plugin manifest";
          entries.set(id, {
            id,
            dir,
            diagnostic: { code: "plugin_manifest_invalid", detail },
            hooks: this.declaredHooks(dir),
          });
        }
      }
    }
    const head = (policy.order ?? []).map((id) => entries.get(id)).filter((
      entry,
    ): entry is CatalogEntry => entry !== undefined);
    const ordered = new Set(head.map((entry) => entry.id));
    return [
      ...head,
      ...[...entries.values()].filter((entry) => !ordered.has(entry.id)),
    ];
  }
  private networkPlugins(): NetworkPlugin[] {
    return this.inventory().map((entry) => ({
      id: entry.id,
      dir: entry.dir,
      manifest: entry.manifest,
      browserComponents: [
        ...entry.manifest?.hasClient ? ["editor" as const] : [],
        ...entry.manifest?.runtime.client ? ["runtime" as const] : [],
      ],
    }));
  }
  private enabled(id: string): boolean {
    const { policy, automatic } = this.policy.selection();
    return this.inventory(policy).some((entry) => entry.id === id) &&
      policyEnables(policy, id, automatic);
  }
  private epoch(id: string): number {
    return this.ownerEpochs.get(id) ?? 0;
  }
  private advance(id: string): void {
    this.ownerEpochs.set(id, this.epoch(id) + 1);
    this.startPromise = null;
  }
  private current(owner: RenderOwner): boolean {
    return this.renderOwners.get(owner.id) === owner &&
      owner.epoch === this.epoch(owner.id) &&
      ["starting", "ready"].includes(owner.state) && this.enabled(owner.id);
  }
  private track(retirement: Promise<void>): Promise<void> {
    this.retirements.add(retirement);
    retirement.then(
      () => this.retirements.delete(retirement),
      () => this.retirements.delete(retirement),
    );
    return retirement;
  }
  private retireRender(id: string): void {
    const owner = this.renderOwners.get(id);
    if (!owner || owner.state === "retired") return;
    owner.state = "retired";
    owner.cancel.resolve();
    this.hosts.delete(id);
    const host = owner.host;
    owner.host = null;
    host?.stop();
    this.startPromise = null;
  }
  private retireUndesiredOwners(): void {
    const ids = new Set([
      ...this.renderOwners.keys(),
      ...this.serviceRuntime?.ownerIds() ?? [],
      ...this.seenEnabled.keys(),
    ]);
    for (const id of ids) {
      if (!this.enabled(id) && this.seenEnabled.get(id) !== false) {
        this.seenEnabled.set(id, false);
        this.advance(id);
        this.retireRender(id);
        if (this.serviceRuntime) {
          this.track(this.serviceRuntime.retireOwner(id, false));
        }
      }
    }
  }

  private declaredHooks(dir: string): HookName[] {
    try {
      const raw = JSON.parse(
        Deno.readTextFileSync(pluginCodePath(dir, "manifest.json")),
      );
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

  /** Authoritative inventory includes disabled/failed plugins and only public metadata. */
  async catalog() {
    const { policy, metadata } = await this.policy.read();
    return {
      contractVersion: PLUGIN_CONTRACT_VERSION,
      policy: metadata,
      plugins: await Promise.all(
        this.inventory(policy).map(
          async ({ id, manifest, diagnostic, hooks: declaredHooks }) => {
            let permissions: PermissionView | null = null;
            let permissionDiagnostic: PluginDiagnostic | undefined;
            try {
              permissions = await this.network.view(id);
            } catch (error) {
              permissionDiagnostic = {
                code: error instanceof PluginContractError
                  ? error.code
                  : "permission_source_unavailable",
                detail: error instanceof Error
                  ? error.message
                  : "server permissions unavailable",
              };
            }
            const enabled = policyEnables(
              policy,
              id,
              metadata.effectiveAutoEnable,
            );
            const runtime = this.serviceRuntime?.status(id);
            const render = this.renderOwners.get(id);
            const status: PluginStatus = !enabled
              ? "disabled"
              : diagnostic
              ? "failed"
              : render?.state === "failed"
              ? "failed"
              : render?.state === "starting" ||
                  (render?.state === "ready" && !render.host?.available)
              ? "starting"
              : this.hosts.has(id)
              ? "ready"
              : "discovered";
            return {
              id,
              name: manifest?.name ?? id,
              version: manifest?.version ?? "unknown",
              enabled,
              status: enabled && !diagnostic && runtime &&
                  (manifest?.runtime.server || manifest?.hasEndpoints ||
                    !manifest?.entry)
                ? runtime.status
                : status,
              client: manifest?.hasClient ?? false,
              runsInBrowser: !!manifest?.hasClient ||
                !!manifest?.runtime.client,
              browserComponents: [
                ...manifest?.hasClient ? ["editor" as const] : [],
                ...manifest?.runtime.client ? ["runtime" as const] : [],
              ],
              runtime: {
                server: !!manifest?.runtime.server,
                client: !!manifest?.runtime.client,
              },
              rendering: !!manifest?.entry,
              endpoints: manifest?.hasEndpoints ?? false,
              capabilities: manifest?.capabilities ?? null,
              permissions,
              pages: manifest?.settings ?? [],
              hooks: manifest?.hooks ?? declaredHooks ?? [],
              blocking: {
                active: enabled &&
                  (manifest?.hooks ?? declaredHooks ?? []).some((name) =>
                    name.startsWith("pre-")
                  ),
                actions: (manifest?.hooks ?? declaredHooks ?? []).filter((
                  name,
                ) => name.startsWith("pre-")).map((name) => name.slice(4)),
              },
              diagnostics: [
                ...diagnostic ? [diagnostic] : [],
                ...this.renderOwners.get(id)?.diagnostic
                  ? [this.renderOwners.get(id)!.diagnostic!]
                  : [],
                ...runtime?.diagnostics ?? [],
                ...permissionDiagnostic ? [permissionDiagnostic] : [],
              ],
              degraded: runtime?.degraded ?? false,
              deliveryFailures: runtime?.deliveryFailures ?? 0,
              commands:
                this.serviceRuntime?.commands().filter((command) =>
                  command.pluginId === id
                ) ?? [],
            };
          },
        ),
      ),
    };
  }

  /** Existing enabled-only API shape is retained for legacy editor loaders. */
  listPlugins(): {
    id: string;
    name: string;
    version: string;
    client: boolean;
  }[] {
    return this.orderedManifests().map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      client: m.hasClient,
    }));
  }
  getClientModule(id: string): string | null {
    return this.getModule(id, "editor");
  }
  getModule(id: string, role: "editor" | "application"): string | null {
    const manifest = this.orderedManifests().find((m) => m.id === id);
    if (!manifest) return null;
    const name = role === "editor"
      ? manifest.hasClient ? manifest.clientEntry : undefined
      : manifest.runtime.client;
    if (!name) return null;
    try {
      return Deno.readTextFileSync(pluginCodePath(manifest.dir, name));
    } catch {
      return null;
    }
  }
  getStyleContents(): { id: string; css: string }[] {
    const out: { id: string; css: string }[] = [];
    for (const manifest of this.orderedManifests()) {
      try {
        const file = pluginCodePath(manifest.dir, "styles.css");
        if (Deno.statSync(file).isFile) {
          out.push({ id: manifest.id, css: Deno.readTextFileSync(file) });
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.error(`plugin '${manifest.id}' stylesheet unavailable`);
        }
      }
    }
    return out;
  }
  enabledManifests(): PluginManifest[] {
    return this.orderedManifests();
  }
  configureRuntime(
    adapters: Omit<RuntimeAdapters, "vaultPath" | "statePath">,
    limits: Partial<PluginLimits> = {},
  ): PluginRuntime {
    if (this.serviceRuntime) {
      throw new Error("plugin runtime is already configured");
    }
    this.networkCommit = (effect) => adapters.commit(effect);
    this.networkChanged = () => adapters.changed?.();
    this.serviceRuntime = new PluginRuntime(
      () => {
        const { policy, automatic } = this.policy.selection();
        return this.inventory(policy).map((entry) => ({
          ...entry,
          enabled: policyEnables(policy, entry.id, automatic),
          hooks: entry.manifest?.hooks ?? entry.hooks ?? [],
        }));
      },
      {
        ...adapters,
        network: this.network,
        ownerEpoch: (id) => this.epoch(id),
        ownerEnabled: (id) => this.enabled(id),
        vaultPath: this.vaultPath,
        statePath: this.statePath,
      },
      limits,
    );
    return this.serviceRuntime;
  }
  get runtime(): PluginRuntime | null {
    return this.serviceRuntime;
  }
  private orderedManifests(): PluginManifest[] {
    const { policy, automatic } = this.policy.selection();
    return this.inventory(policy).filter((entry) =>
      policyEnables(policy, entry.id, automatic)
    ).flatMap((entry) => entry.manifest ? [entry.manifest] : []);
  }
  ensureStarted(): Promise<void> {
    this.renderRequested = true;
    if (this.startPromise) return this.startPromise;
    const pending = this.start();
    this.startPromise = pending;
    pending.finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    }).catch(() => undefined);
    return pending;
  }
  start(): Promise<void> {
    this.renderRequested = true;
    this.retireUndesiredOwners();
    return Promise.all(
      this.orderedManifests().filter((manifest) => manifest.entry).map(
        (manifest) => this.startRender(manifest.id),
      ),
    ).then(() => undefined);
  }
  private startRender(
    id: string,
    desired?: NetworkPolicy,
    ceiling?: PermissionDeclaration,
  ): Promise<RenderStartOutcome> {
    const existing = this.renderOwners.get(id);
    if (
      existing && existing.epoch === this.epoch(id) &&
      existing.state !== "retired"
    ) return existing.starting ?? Promise.resolve(this.renderOutcome(existing));
    const owner: RenderOwner = {
      id,
      epoch: this.epoch(id),
      state: "starting",
      host: null,
      cancel: Promise.withResolvers<void>(),
      ...(desired && ceiling ? { recoveryAdmission: desired } : {}),
    };
    this.renderOwners.set(id, owner);
    this.seenEnabled.set(id, true);
    const starting = (async (): Promise<RenderStartOutcome> => {
      let policy = desired ?? await this.network.policy(id);
      if (!this.current(owner)) return { state: "retired" };
      const latest = await this.network.policy(id);
      if (!this.current(owner)) return { state: "retired" };
      if (
        policy.source.codeFingerprint !== latest.source.codeFingerprint ||
        (ceiling && !equalSource(policy.source, latest.source))
      ) {
        throw new Error(
          "render desired source/permissions changed before construction",
        );
      }
      policy = latest;
      if (ceiling) {
        const rights = {
          network: intersectScopes(latest.effective.network, ceiling.network),
          imports: intersectScopes(latest.effective.imports, ceiling.imports),
        };
        policy = {
          ...latest,
          effective: rights,
          fingerprint: permissionFingerprint(rights.network, rights.imports),
        };
      }
      const manifest = this.orderedManifests().find((manifest) =>
        manifest.id === id
      );
      if (!manifest?.entry) {
        throw new Error("render contribution is unavailable");
      }
      owner.source = policy.source;
      owner.fingerprint = policy.fingerprint;
      const host: PluginHost = new PluginHost(
        manifest,
        this.vaultPath,
        (method, args, authority) => {
          if (
            !authority || !this.current(owner) || owner.host !== host
          ) return Promise.reject(new Error("render owner is retired"));
          const bound: RpcAuthority = {
            ...authority,
            current: () =>
              this.current(owner) && owner.host === host && authority.current(),
            generationCurrent: () =>
              this.current(owner) && owner.host === host &&
              authority.generationCurrent(),
          };
          if (method === "settings.read") {
            return new PluginDataStore(this.statePath, {
              commit: (effect) => this.networkCommit(effect),
              settingsSchema: (owner) => this.network.settingsSchema(owner),
            }).forPlugin(id).settings(manifest.settings);
          }
          return method.startsWith("permissions.")
            ? this.network.rpc(id, method, args, bound)
            : this.rpc
            ? this.rpc(method, args, bound)
            : this.renderRpc(manifest, method, args);
        },
        this.workerCount,
        {
          writable: this.options.renderWritable?.() ?? true,
          effective: policy.effective,
          source: policy.source,
          renderRecovery: (previous) =>
            this.admitRenderRecovery(owner, host, previous),
          registrationChanged: () => {
            if (this.renderOwners.get(id) === owner && owner.host === host) {
              this.networkChanged();
            }
          },
          failed: (detail) => {
            if (!this.current(owner) || owner.host !== host) return;
            owner.state = "failed";
            owner.diagnostic = {
              code: "plugin_render_recovery_failed",
              detail,
            };
            this.hosts.delete(id);
            this.networkChanged();
          },
        },
      );
      owner.host = host; // Starting actors may publish; pipeline selection still excludes them.
      try {
        await host.start();
        if (!this.current(owner)) {
          host.stop();
          return owner.state === "failed"
            ? this.renderOutcome(owner)
            : { state: "retired" };
        }
        const readyPolicy = await this.network.policy(id);
        if (!this.current(owner)) {
          host.stop();
          return owner.state === "failed"
            ? this.renderOutcome(owner)
            : { state: "retired" };
        }
        if (
          policy.source.codeFingerprint !==
            readyPolicy.source.codeFingerprint ||
          (ceiling && !equalSource(policy.source, readyPolicy.source)) ||
          ["network", "imports"].some((kind) =>
            host.delegated[kind as keyof PermissionDeclaration].some((scope) =>
              !scopesCover(
                readyPolicy.effective[kind as keyof PermissionDeclaration],
                scope,
              )
            )
          )
        ) {
          throw new Error(
            "render desired source/permissions changed before ready publication",
          );
        }
        if (!host.available) {
          throw new Error(
            "demanded render Worker unavailable before ready publication",
          );
        }
        owner.state = "ready";
        owner.recoveryAdmission = undefined;
        this.hosts.set(id, host);
        logger.info(`plugin '${id}' loaded (${this.workerCount} workers)`);
        return this.renderOutcome(owner);
      } catch (error) {
        host.stop();
        throw error;
      }
    })().catch((error): RenderStartOutcome => {
      if (!this.current(owner)) {
        return this.renderOwners.get(id) === owner && owner.state === "failed"
          ? this.renderOutcome(owner)
          : { state: "retired" };
      }
      owner.host?.stop();
      owner.host = null;
      owner.state = "failed";
      owner.diagnostic = {
        code: "plugin_render_activation_failed",
        detail: error instanceof Error
          ? error.message
          : "render activation failed",
      };
      logger.error(
        `plugin '${id}' failed to start: ${owner.diagnostic.detail}`,
      );
      return this.renderOutcome(owner);
    });
    owner.starting = Promise.race([
      starting,
      owner.cancel.promise.then((): RenderStartOutcome => ({
        state: "retired",
      })),
    ]).finally(
      () => {
        if (this.renderOwners.get(id) === owner) owner.starting = undefined;
      },
    );
    return owner.starting;
  }
  private renderLease(owner: RenderOwner): RenderOwnerLease {
    return {
      pluginId: owner.id,
      epoch: owner.epoch,
      host: owner.host!,
      generations: owner.host!.generations,
      source: owner.source,
    };
  }
  private renderOutcome(owner: RenderOwner): RenderStartOutcome {
    if (
      this.current(owner) && owner.state === "ready" && owner.host?.available
    ) return { state: "ready", lease: this.renderLease(owner) };
    if (this.renderOwners.get(owner.id) === owner && owner.state === "failed") {
      return {
        state: "failed",
        diagnostic: owner.diagnostic ??
          { code: "plugin_render_unavailable", detail: "render owner failed" },
      };
    }
    return { state: "retired" };
  }
  /** Sole asynchronous admission seam for one failed replica of this pool. */
  private async admitRenderRecovery(
    owner: RenderOwner,
    host: PluginHost,
    previous: RenderRecoveryAdmission,
  ): Promise<RenderRecoveryAdmission> {
    if (!this.current(owner) || owner.host !== host || !previous.source) {
      throw new Error("render recovery owner is retired or unavailable");
    }
    const policy = await this.network.policy(owner.id);
    if (!this.current(owner) || owner.host !== host) {
      throw new Error("render recovery owner was superseded");
    }
    if (previous.source.codeFingerprint !== policy.source.codeFingerprint) {
      throw new Error(
        "source-reload-required: render recovery cannot consume changed installed code",
      );
    }
    return {
      source: policy.source,
      effective: {
        network: intersectScopes(
          policy.effective.network,
          previous.effective.network,
        ),
        imports: intersectScopes(
          policy.effective.imports,
          previous.effective.imports,
        ),
      },
      writable: this.options.renderWritable?.() ?? true,
    };
  }
  readyRenderOwners(): RenderOwnerLease[] {
    return this.orderedManifests().flatMap((manifest) => {
      const owner = this.renderOwners.get(manifest.id);
      return owner?.state === "ready" && owner.host?.available &&
          this.current(owner)
        ? [this.renderLease(owner)]
        : [];
    });
  }
  renderOwnerCurrent(lease: RenderOwnerLease): boolean {
    const owner = this.renderOwners.get(lease.pluginId);
    return !!owner && this.current(owner) && owner.state === "ready" &&
      owner.host === lease.host && owner.epoch === lease.epoch &&
      JSON.stringify(lease.generations) ===
        JSON.stringify(lease.host.generations) &&
      lease.host.available;
  }
  /** Called after committed policy; synchronous retirement precedes all awaits. */
  async reconcileOwners(options: { replaceId?: string } = {}): Promise<void> {
    this.retireUndesiredOwners();
    for (const source of this.inventory()) {
      if (
        this.enabled(source.id) && this.seenEnabled.get(source.id) === false
      ) {
        this.advance(source.id);
        this.seenEnabled.set(source.id, true);
      }
    }
    if (options.replaceId && this.enabled(options.replaceId)) {
      const id = options.replaceId,
        epoch = this.epoch(id),
        policy = await this.network.policy(id);
      if (this.enabled(id) && this.epoch(id) === epoch) {
        const render = this.renderOwners.get(id),
          serviceSource = this.serviceRuntime?.ownerSource(id);
        const changed =
          (render?.source && !equalSource(render.source, policy.source)) ||
          (serviceSource && !equalSource(serviceSource, policy.source));
        if (changed) {
          this.advance(id);
          this.retireRender(id);
          if (this.serviceRuntime) {
            this.track(this.serviceRuntime.retireOwner(id, true));
          }
        } else if (
          render?.state === "failed" ||
          (render?.state === "starting" && !render.source)
        ) this.retireRender(id);
      }
    }
    await this.serviceRuntime?.reconcile();
    if (this.renderRequested) await this.ensureStarted();
    await Promise.all([...this.retirements]);
    this.networkChanged();
  }
  private revokeReduced(id: string, next: PermissionDeclaration): void {
    const owner = this.renderOwners.get(id), old = owner?.host?.delegated;
    if (
      old &&
      ["network", "imports"].some((kind) =>
        old[kind as keyof PermissionDeclaration].some((scope) =>
          !scopesCover(next[kind as keyof PermissionDeclaration], scope)
        )
      )
    ) this.retireRender(id);
    this.serviceRuntime?.revokeNetworkReduced(id, next);
  }
  /** One owner facade captures both roles before settings retirement. */
  private captureSettingsRecovery(
    id: string,
    desired: NetworkPolicy,
  ): SettingsOwnerRecovery {
    const service = this.serviceRuntime?.captureSettingsRecovery(id, desired);
    const owner = this.renderOwners.get(id), epoch = this.epoch(id);
    const originalSource = owner?.source ?? owner?.recoveryAdmission?.source;
    const old = owner?.host?.delegated ?? owner?.recoveryAdmission?.effective;
    const render = owner && originalSource && old && this.renderRequested &&
        (owner.recoveryAdmission ||
          ["network", "imports"].some((kind) =>
            old[kind as keyof PermissionDeclaration].some((scope) =>
              !scopesCover(
                desired.effective[kind as keyof PermissionDeclaration],
                scope,
              )
            )
          ))
      ? owner
      : undefined;
    const host = render?.host;
    let fenced = false;
    return {
      validate: () => {
        service?.validate();
        if (
          render &&
          (this.renderOwners.get(id) !== render || render.host !== host ||
            this.epoch(id) !== epoch)
        ) {
          throw new PluginContractError(
            409,
            "permission_source_conflict",
            "render owner changed before settings effect",
          );
        }
      },
      fence: () => {
        service?.fence();
        if (
          !fenced && render && this.renderOwners.get(id) === render &&
          render.host === host && this.epoch(id) === epoch
        ) {
          this.retireRender(id);
          fenced = true;
        }
      },
      admit: async () => {
        await service?.admit();
        if (
          !fenced || !render || !originalSource || this.epoch(id) !== epoch ||
          !this.enabled(id) || this.renderOwners.get(id) !== render ||
          render.state !== "retired" || !this.renderRequested
        ) return;
        if (originalSource.codeFingerprint !== desired.source.codeFingerprint) {
          throw new Error(
            "source-reload-required: settings recovery cannot consume changed installed render code",
          );
        }
        const latest = await this.network.policy(id);
        if (!equalSource(latest.source, desired.source)) {
          throw new Error(
            latest.source.codeFingerprint !== desired.source.codeFingerprint
              ? "source-reload-required: installed render code changed during settings recovery"
              : "settings render recovery source changed before admission",
          );
        }
        if (
          this.epoch(id) !== epoch || !this.enabled(id) ||
          this.renderOwners.get(id) !== render || render.state !== "retired" ||
          !this.renderRequested
        ) return;
        // Start is admitted and internally contained; success ACK does not
        // await Worker initialization or initial onSync publications.
        this.startRender(id, desired, desired.effective).catch(() => undefined);
      },
    };
  }
  async reloadPermissions(id: string, desired: NetworkPolicy): Promise<void> {
    const epoch = this.epoch(id);
    if (!this.enabled(id)) return;
    const latest = await this.network.policy(id);
    if (
      epoch !== this.epoch(id) || !this.enabled(id) ||
      !equalSource(desired.source, latest.source) ||
      desired.fingerprint !== latest.fingerprint
    ) {
      throw new PluginContractError(
        409,
        "permission_reload_superseded",
        "permission replacement source or owner was superseded before admission",
      );
    }
    const owner = this.renderOwners.get(id);
    const shouldRender = !!owner && this.renderRequested;
    const existing = owner?.host?.delegated;
    if (
      owner &&
      (owner.state !== "ready" || !owner.source ||
        !equalSource(owner.source, desired.source) || !existing ||
        permissionFingerprint(existing.network, existing.imports) !==
          desired.fingerprint)
    ) this.retireRender(id);
    await this.serviceRuntime?.reloadNetwork(id, desired.effective);
    if (epoch !== this.epoch(id) || !this.enabled(id)) {
      throw new PluginContractError(
        409,
        "permission_reload_superseded",
        "permission replacement owner was retired before readiness",
      );
    }
    if (shouldRender) {
      const outcome = await this.startRender(id, desired);
      if (outcome.state !== "ready") {
        throw new PluginContractError(
          503,
          "permission_reload_failed",
          outcome.state === "failed"
            ? outcome.diagnostic.detail
            : "demanded render replacement was retired or superseded before readiness",
        );
      }
      if (epoch !== this.epoch(id) || !this.renderOwnerCurrent(outcome.lease)) {
        throw new PluginContractError(
          409,
          "permission_reload_superseded",
          "demanded render replacement is no longer current",
        );
      }
    }
  }
  stop(): void {
    for (const id of this.renderOwners.keys()) {
      this.advance(id);
      this.retireRender(id);
    }
    this.hosts.clear();
    this.renderRequested = false;
    this.startPromise = null;
  }
  /** Ordinary changes retain workers and broadcast legacy sync to every replica. */
  syncAll(snapshot?: OperationFact): Promise<void> {
    const next = this.syncBoundary.catch(() => undefined).then(async () => {
      for (const owner of this.readyRenderOwners()) {
        if (this.renderOwnerCurrent(owner)) await owner.host.syncAll();
      }
      this.serviceRuntime?.post(
        "on-sync",
        snapshot ?? {
          operationId: crypto.randomUUID(),
          action: "sync",
          origin: "external",
          timestamp: new Date().toISOString(),
          initial: false,
        },
      );
    });
    this.syncBoundary = next;
    return next;
  }
}
