// SPDX-License-Identifier: LGPL-3.0-only

import * as path from "@std/path";
import { logger } from "../logger.ts";
import {
  pluginCodePath,
  type PluginManifest,
  workerPermissions,
} from "./manifest.ts";
import {
  type HandlerRegistration,
  type HostMessage,
  HTTP_METHODS,
  type JsonValues,
  PLUGIN_LIMITS,
  PluginContractError,
  type PluginLimits,
  record,
  stableId,
  text,
  type WorkerMessage,
} from "./contracts.ts";
import {
  type ExecutionContext,
  executionContext,
  type ReleaseOutcome,
} from "./execution_context.ts";
import { compileEndpointTable } from "./endpoint_table.ts";
import {
  canonicalScopes,
  NETWORK_LIMITS,
  type PermissionDeclaration,
  type Source,
  unionScopes,
} from "./network_contracts.ts";

const HEARTBEAT_MS = 250;
const WORKER_URL = new URL("./worker_entry.ts", import.meta.url);
export interface RpcAuthority {
  generation: string;
  role: "render" | "service";
  pre: boolean;
  /** Causal operation context of the currently executing handler, when the
   * handler was invoked with an OperationFact payload. */
  causal?: { parentId?: string; depth: number };
  current(): boolean;
  generationCurrent(): boolean;
  release: Promise<ReleaseOutcome>;
  /** Host-only lifetime signal, settled at authority retirement even when idle. */
  generationRetired: Promise<void>;
  /** Immutable installed-code/settings source of this activation. */
  source?: Source;
  /** Private transport receipt plus activation/initial-sync settlement. */
  receipt?: Promise<ReleaseOutcome>;
  readiness?: Promise<ReleaseOutcome>;
}
export interface InvocationOptions {
  generation?: string;
  causal?: { parentId?: string; depth: number };
}
export type RpcHandler = (
  method: string,
  args: unknown[],
  authority?: RpcAuthority,
) => Promise<unknown>;
/** Host-only, manager-admitted same-code replacement for one failed replica. */
export interface RenderRecoveryAdmission {
  readonly source?: Source;
  readonly effective: PermissionDeclaration;
  readonly writable?: boolean;
}
export interface HostOptions {
  role?: "render" | "service";
  writable?: boolean;
  snapshot?: JsonValues;
  limits?: Partial<PluginLimits>;
  registrationChanged?(): void;
  failed?(detail: string): void;
  effective?: PermissionDeclaration;
  source?: Source;
  renderRecovery?(
    previous: RenderRecoveryAdmission,
  ): Promise<RenderRecoveryAdmission>;
}
interface Job {
  id: number;
  kind: "call" | "invoke" | "dispose";
  name: string;
  args: unknown[];
  pre: boolean;
  target?: Slot;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  context?: ExecutionContext;
  invocation?: InvocationOptions;
}
interface Slot {
  worker: Worker;
  generation: string;
  ready: boolean;
  usable: boolean;
  retired: boolean;
  generationRetired: Promise<void>;
  retireGeneration(): void;
  source?: Source;
  exports: Set<string>;
  lastHeartbeat: number;
  provenAlive: boolean;
  lastDispatch: number;
  /** FIFO lane: renders, observer invocations, commands — one at a time. */
  active: Job | null;
  /** Guard lane: pre-hook invocations never queue behind observers, so an
   * on-only plugin's slow/hanging handler cannot acquire blocking power.
   * The note-operation lock serializes operations, so at most one guard is
   * in flight per plugin. */
  activeGuard: Job | null;
  bootTimer?: ReturnType<typeof setTimeout>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  readyPromise: Promise<void>;
  background: ExecutionContext;
  contexts: Map<string, ExecutionContext>;
  permissions: PermissionDeclaration;
  receipts: Map<
    number,
    {
      sent: boolean;
      context: ExecutionContext;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
}

/** One service slot or the existing render pool. Calls are never replayed. */
export class PluginHost {
  readonly role: "render" | "service";
  private readonly registry = new Map<string, HandlerRegistration>();
  get registrations(): ReadonlyMap<string, HandlerRegistration> {
    return new Map(
      [...this.registry].map((
        [id, descriptor],
      ) => [id, structuredClone(descriptor)]),
    );
  }
  readonly limits: PluginLimits;
  private slots: Slot[] = [];
  private queue: Job[] = [];
  /** Service guards have their own bounded pending admission, independent of FIFO. */
  private guardQueue: Job[] = [];
  private sequence = 0;
  private stopped = false;
  private stopping = false;
  private failedDetail: string | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private startIdentity?: object;
  /** False until construction is admitted; true while its new slot initializes. */
  private readonly renderRecoveries = new Map<object, boolean>();

  constructor(
    readonly manifest: PluginManifest,
    private readonly vaultPath: string,
    private readonly rpc: RpcHandler,
    private readonly workerCount: number,
    private readonly options: HostOptions = {},
  ) {
    this.role = options.role ?? "render";
    this.limits = { ...PLUGIN_LIMITS, ...options.limits };
    if (this.role === "render" && !manifest.entry) {
      throw new Error("render host requires a rendering entry");
    }
    if (this.role === "service" && workerCount !== 1) {
      throw new Error(
        "service contributions require exactly one authoritative worker",
      );
    }
  }
  get generation(): string | null {
    return this.slots[0]?.generation ?? null;
  }
  get generations(): readonly string[] {
    return this.slots.map((slot) => slot.generation);
  }
  get delegated(): PermissionDeclaration {
    return {
      network: unionScopes(
        ...this.slots.map((slot) => slot.permissions.network),
      ),
      imports: unionScopes(
        ...this.slots.map((slot) => slot.permissions.imports),
      ),
    };
  }
  get available(): boolean {
    return !this.stopped && !this.stopping && !this.failedDetail &&
      this.slots.length > 0 && this.renderRecoveries.size === 0 &&
      this.slots.every((slot) => slot.ready);
  }
  get renderCapable(): boolean {
    return this.slots.some((slot) =>
      slot.usable && slot.exports.has("getSelectors") &&
      slot.exports.has("parseNode")
    );
  }
  async start(): Promise<void> {
    const identity = {};
    this.startIdentity = identity;
    this.stopped = false;
    this.stopping = false;
    this.failedDetail = null;
    this.renderRecoveries.clear();
    const owned: Slot[] = [];
    this.slots = owned;
    try {
      // Each successful construction is cleanup-owned before constructing the next.
      for (let index = 0; index < this.workerCount; index++) {
        owned.push(this.spawn());
      }
      this.watchdog = setInterval(() => this.checkHeartbeats(), HEARTBEAT_MS);
      await Promise.all(owned.map((slot) => slot.readyPromise));
      if (this.startIdentity !== identity) {
        throw new Error("plugin start owner retired");
      }
    } catch (error) {
      if (this.startIdentity === identity) this.stop();
      throw error;
    }
  }
  private valid(slot: Slot): boolean {
    return !this.stopped && !this.failedDetail && !slot.retired &&
      this.slots.includes(slot);
  }
  private spawn(admission?: RenderRecoveryAdmission): Slot {
    const entry = this.role === "service"
      ? this.manifest.runtime.server
      : this.manifest.entry;
    const pluginUrl = entry
      ? path.toFileUrl(pluginCodePath(this.manifest.dir, entry)).href
      : undefined;
    const endpointsUrl = this.role === "service" && this.manifest.hasEndpoints
      ? path.toFileUrl(
        pluginCodePath(this.manifest.dir, "endpoints") + path.SEPARATOR,
      ).href
      : undefined;
    const permissions = workerPermissions(this.manifest, this.vaultPath, {
      role: this.role,
      writable: admission ? admission.writable : this.options.writable,
      effective: admission ? admission.effective : this.options.effective,
    });
    if (typeof permissions !== "object") {
      throw new Error("explicit Worker permissions are required");
    }
    const worker = new Worker(WORKER_URL, {
      type: "module",
      deno: {
        permissions,
      },
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Replacement slots can fail before a consumer awaits the readiness promise.
    readyPromise.catch(() => undefined);
    const generationRetired = Promise.withResolvers<void>();
    const slot: Slot = {
      worker,
      generation: crypto.randomUUID(),
      ready: false,
      usable: true,
      retired: false,
      generationRetired: generationRetired.promise,
      retireGeneration: generationRetired.resolve,
      source: admission?.source
        ? structuredClone(admission.source)
        : !admission && this.options.source
        ? structuredClone(this.options.source)
        : undefined,
      exports: new Set(),
      lastHeartbeat: Date.now(),
      provenAlive: false,
      lastDispatch: 0,
      active: null,
      activeGuard: null,
      resolveReady,
      rejectReady,
      readyPromise,
      background: executionContext("background", false),
      contexts: new Map(),
      permissions: {
        network: canonicalScopes(permissions.net ?? false),
        imports: canonicalScopes(permissions.import ?? false),
      },
      receipts: new Map(),
    };
    const bootDeadline = setTimeout(
      () => this.fail(slot, "plugin activation deadline exceeded"),
      this.limits.activationMs,
    );
    slot.bootTimer = bootDeadline;
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (!data || typeof data !== "object") {
        this.fail(slot, "invalid worker envelope");
        return;
      }
      if (!this.valid(slot) || data.generation !== slot.generation) return;
      if (data.type === "heartbeat") {
        slot.lastHeartbeat = Date.now();
        slot.provenAlive = true;
        return;
      }
      if (data.type === "initError") {
        clearTimeout(bootDeadline);
        this.fail(slot, `plugin failed to load: ${data.value}`);
        return;
      }
      if (data.type === "ready") {
        if (
          !Array.isArray(data.exports) ||
          data.exports.some((name) => typeof name !== "string")
        ) {
          this.fail(slot, "invalid worker export descriptor");
          return;
        }
        slot.exports = new Set(data.exports);
        slot.lastHeartbeat = Date.now();
        slot.provenAlive = true;
        if (this.role === "service") {
          try {
            compileEndpointTable(
              [...this.registry].filter(([, entry]) =>
                entry.kind === "endpoint"
              ).map(([handlerId, entry]) => ({
                handlerId,
                descriptor: entry.definition,
              })),
            );
          } catch (error) {
            this.fail(
              slot,
              error instanceof Error ? error.message : "invalid endpoint table",
            );
            return;
          }
          const missing = this.manifest.hooks.filter((hook) =>
            hook.startsWith("pre-") &&
            ![...this.registrations.values()].some((r) =>
              r.kind === "hook" && r.id === hook
            )
          );
          if (missing.length) {
            clearTimeout(bootDeadline);
            this.fail(
              slot,
              `required pre-hook registration missing: ${missing.join(", ")}`,
            );
            return;
          }
        }
        const initialized = this.role === "render" && slot.exports.has("onSync")
          ? this.enqueue(
            "call",
            "onSync",
            [],
            false,
            this.limits.serviceCallMs,
            slot,
            true,
          )
          : Promise.resolve();
        initialized.then(() => {
          clearTimeout(bootDeadline);
          if (!this.valid(slot)) return;
          slot.ready = true;
          slot.background.settle({ status: "settled" });
          slot.resolveReady();
          this.pump();
        }, (error) => {
          this.fail(
            slot,
            `plugin initial onSync failed: ${
              error instanceof Error
                ? error.message
                : "initial synchronization failed"
            }`,
          );
        });
        return;
      }
      if (data.type === "register") {
        try {
          if (
            this.role !== "service" || this.stopping ||
            this.registrations.has(data.handlerId)
          ) throw new Error("invalid handler registration lifetime");
          if (
            typeof data.handlerId !== "string" || data.handlerId.length > 128
          ) throw new Error("invalid handler identity");
          this.validateRegistration(data.registration);
          this.registry.set(data.handlerId, structuredClone(data.registration));
          this.options.registrationChanged?.();
        } catch (error) {
          this.fail(
            slot,
            error instanceof Error ? error.message : "invalid registration",
          );
        }
        return;
      }
      if (data.type === "unregister") {
        const removed = this.registrations.get(data.handlerId);
        this.registry.delete(data.handlerId);
        this.options.registrationChanged?.();
        if (
          !this.stopping && removed?.kind === "hook" &&
          removed.id.startsWith("pre-")
        ) this.fail(slot, "required pre-hook registration disposed");
        return;
      }
      if (data.type === "result") {
        const job = slot.activeGuard?.id === data.id
          ? slot.activeGuard
          : slot.active;
        if (!job || job.id !== data.id) return;
        if (!job.context || job.context.reference.id !== data.contextId) return;
        job.context.close({ status: "settled" });
        slot.contexts.delete(job.context.reference.id);
        clearTimeout(job.timer);
        if (slot.activeGuard?.id === data.id) slot.activeGuard = null;
        else slot.active = null;
        if (data.ok) job.resolve(data.value);
        else job.reject(new Error(String(data.value)));
        this.pump();
        return;
      }
      if (data.type === "rpcReceipt") {
        const receipt = slot.receipts.get(data.id);
        if (!receipt?.sent) return;
        clearTimeout(receipt.timer);
        receipt.context.settle({ status: "settled" });
        slot.receipts.delete(data.id);
        return;
      }
      if (data.type === "rpc") {
        const context = data.contextId === slot.background.reference.id
          ? slot.background
          : slot.contexts.get(data.contextId);
        const generationCurrent = () => this.valid(slot) && !this.stopping;
        if (!context?.open || !generationCurrent()) {
          worker.postMessage(
            {
              type: "rpcResponse",
              generation: slot.generation,
              id: data.id,
              ok: false,
              value: "plugin invocation context is unavailable or closed",
            } satisfies HostMessage,
          );
          return;
        }
        const receiptRequired = [
          "permissions.declare",
          "permissions.requestAccess",
        ].includes(data.method);
        if (receiptRequired && slot.receipts.size >= this.limits.queuedJobs) {
          worker.postMessage(
            {
              type: "rpcResponse",
              generation: slot.generation,
              id: data.id,
              ok: false,
              value: "permission transport admission is full",
              error: { status: 503, code: "permission_admission_full" },
            } satisfies HostMessage,
          );
          return;
        }
        const receipt = receiptRequired
          ? executionContext("background", false)
          : undefined;
        if (receipt) {
          const timer = setTimeout(() => {
            receipt.close({ status: "aborted" });
            slot.receipts.delete(data.id);
          }, NETWORK_LIMITS.receiptMs);
          slot.receipts.set(data.id, { sent: false, context: receipt, timer });
        }
        const authority: RpcAuthority = {
          generation: slot.generation,
          role: this.role,
          // The host's current job determines protection, never a worker flag.
          pre: context.reference.pre,
          causal: context.causal,
          current: () => generationCurrent() && context.open,
          generationCurrent,
          release: context.release,
          generationRetired: slot.generationRetired,
          source: slot.source,
          receipt: receipt?.release,
          readiness: slot.background.release,
        };
        if (!authority.current()) {
          worker.postMessage(
            {
              type: "rpcResponse",
              generation: slot.generation,
              id: data.id,
              ok: false,
              value: "plugin generation authority revoked",
            } satisfies HostMessage,
          );
          return;
        }
        Promise.resolve().then(() =>
          this.rpc(data.method, data.args, authority)
        ).then(
          (value) => {
            if (authority.current()) {
              worker.postMessage(
                {
                  type: "rpcResponse",
                  generation: slot.generation,
                  id: data.id,
                  ok: true,
                  value,
                  receiptRequired,
                } satisfies HostMessage,
              );
              const receipt = slot.receipts.get(data.id);
              if (receipt) receipt.sent = true;
            }
          },
          (error) => {
            if (authority.current()) {
              worker.postMessage(
                {
                  type: "rpcResponse",
                  generation: slot.generation,
                  id: data.id,
                  ok: false,
                  value: error instanceof Error
                    ? error.message
                    : "host service failed",
                  ...(error instanceof PluginContractError
                    ? { error: { status: error.status, code: error.code } }
                    : {}),
                  receiptRequired,
                } satisfies HostMessage,
              );
              const receipt = slot.receipts.get(data.id);
              if (receipt) receipt.sent = true;
            }
          },
        );
      }
    };
    worker.onerror = (error) => {
      error.preventDefault();
      clearTimeout(bootDeadline);
      this.fail(slot, "plugin worker crashed; in-flight outcome unknown");
    };
    try {
      worker.postMessage(
        {
          type: "init",
          generation: slot.generation,
          role: this.role,
          pluginUrl,
          endpointsUrl,
          hooks: this.manifest.hooks,
          snapshot: this.options.snapshot ?? {},
          context: slot.background.reference,
          permissionsSource: slot.source,
        } satisfies HostMessage,
      );
    } catch (error) {
      clearTimeout(bootDeadline);
      slot.retireGeneration();
      slot.background.close({ status: "aborted" });
      worker.terminate();
      slot.rejectReady(new Error("plugin initialization envelope failed"));
      throw error;
    }
    return slot;
  }
  private validateRegistration(registration: HandlerRegistration) {
    const value = record(registration, "registration");
    if (registration.kind === "hook") {
      if (!this.manifest.hooks.includes(registration.id as never)) {
        throw new Error("hook is not declared by this plugin");
      }
    } else if (registration.kind === "command") {
      stableId(registration.id, "command id");
      const definition = record(registration.definition, "command definition");
      if (definition.id !== registration.id || definition.target !== "server") {
        throw new Error(
          "server command definition has an invalid target or identity",
        );
      }
      text(definition.label, "command label");
      if (
        definition.context !== undefined &&
        !["app", "note", "editing"].includes(definition.context as string)
      ) throw new Error("unsupported command context");
      if (
        Object.keys(definition).some((key) =>
          !["id", "label", "target", "context", "description"].includes(key)
        )
      ) throw new Error("unsupported command property");
      if (
        [...this.registrations.values()].some((r) =>
          r.kind === "command" && r.id === registration.id
        )
      ) throw new Error("duplicate plugin command id");
    } else if (registration.kind === "endpoint") {
      const definition = record(registration.definition, "endpoint descriptor");
      if (
        !HTTP_METHODS.includes(definition.method as never) ||
        typeof definition.pattern !== "string" ||
        !definition.pattern.startsWith("/")
      ) throw new Error("invalid endpoint descriptor");
      if (
        [...this.registrations.values()].some((r) =>
          r.kind === "endpoint" && r.id === registration.id
        )
      ) throw new Error("duplicate endpoint descriptor");
      compileEndpointTable([
        ...[...this.registry].filter(([, entry]) => entry.kind === "endpoint")
          .map(([handlerId, entry]) => ({
            handlerId,
            descriptor: entry.definition,
          })),
        { handlerId: "tentative-endpoint", descriptor: definition },
      ]);
    } else if (
      registration.kind !== "settings-change" &&
      registration.kind !== "action-result"
    ) throw new Error("unsupported registration kind");
    if (
      Object.keys(value).some((key) =>
        !["kind", "id", "definition"].includes(key)
      )
    ) throw new Error("unsupported registration property");
  }
  call(fn: string, args: unknown[]): Promise<unknown> {
    if (this.role !== "render") {
      return Promise.reject(
        new Error(
          "service contributions require registered handler invocation",
        ),
      );
    }
    return this.enqueue("call", fn, args, false, this.limits.serviceCallMs);
  }
  invoke(
    handlerId: string,
    args: unknown[],
    pre = false,
    timeout = pre ? this.limits.preHookMs : this.limits.serviceCallMs,
    invocation: InvocationOptions = {},
  ): Promise<unknown> {
    if (!this.registrations.has(handlerId)) {
      return Promise.reject(new Error("plugin handler unavailable"));
    }
    if (invocation.generation && invocation.generation !== this.generation) {
      return Promise.reject(new Error("plugin target generation replaced"));
    }
    return this.enqueue(
      "invoke",
      handlerId,
      args,
      pre,
      timeout,
      undefined,
      false,
      invocation,
    );
  }
  private enqueue(
    kind: Job["kind"],
    name: string,
    args: unknown[],
    pre: boolean,
    timeout: number,
    target?: Slot,
    initialization = false,
    invocation?: InvocationOptions,
  ): Promise<unknown> {
    if (
      this.stopped || this.failedDetail || (this.stopping && kind !== "dispose")
    ) {
      return Promise.reject(
        new Error(this.failedDetail ?? "plugin host stopped"),
      );
    }
    if (
      this.role === "render" &&
      [...this.renderRecoveries.values()].some((admitted) => !admitted) &&
      !initialization &&
      kind !== "dispose"
    ) {
      return Promise.reject(
        new Error("render recovery pending; work was not admitted"),
      );
    }
    const guardLane = pre && this.role === "service";
    if (guardLane && this.guardQueue.length >= 1) {
      return Promise.reject(
        new PluginContractError(
          503,
          "plugin_guard_queue_full",
          "plugin guard queue is full",
        ),
      );
    }
    if (
      this.role === "service" && !guardLane &&
      this.queue.length >= this.limits.queuedJobs
    ) {
      return Promise.reject(
        new PluginContractError(
          503,
          "plugin_queue_full",
          "plugin service queue is full",
        ),
      );
    }
    if (
      this.role === "render" && !initialization && this.slots.length &&
      this.slots.every((slot) => slot.ready && !slot.usable)
    ) return Promise.reject(new Error("render synchronization unavailable"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.sequence,
        kind,
        name,
        args,
        pre,
        target,
        invocation,
        resolve,
        reject,
        timer: setTimeout(() => {
          const pending = guardLane ? this.guardQueue : this.queue;
          const queued = pending.indexOf(job);
          if (queued >= 0) {
            pending.splice(queued, 1);
            reject(new Error("plugin call deadline exceeded while queued"));
            this.pump();
            return;
          }
          const active = this.slots.find((slot) =>
            slot.active === job || slot.activeGuard === job
          );
          if (active) {
            this.fail(
              active,
              "plugin call deadline exceeded; in-flight outcome unknown",
            );
          }
        }, timeout),
      };
      if (initialization && target) this.dispatch(target, job);
      else {
        (guardLane ? this.guardQueue : this.queue).push(job);
        this.pump();
      }
    });
  }
  private pump() {
    if (this.stopped || this.failedDetail) return;
    // Protection admission never inherits a blocked/full ordinary queue. One
    // active guard owns the lane until it settles; one pending guard may wait.
    if (this.role === "service" && this.guardQueue.length) {
      const job = this.guardQueue[0];
      const slot = job.target ??
        this.slots.find((candidate) =>
          candidate.ready && candidate.usable && !candidate.activeGuard
        );
      if (slot?.ready && slot.usable && !slot.activeGuard) {
        this.guardQueue.shift();
        this.dispatch(slot, job);
      }
    }
    while (this.queue.length) {
      const job = this.queue[0];
      const slot = job.target
        ? job.target.ready && !job.target.active ? job.target : undefined
        : this.slots.filter((s) => s.ready && s.usable && !s.active).sort((
          a,
          b,
        ) => a.lastDispatch - b.lastDispatch)[0];
      if (!slot) return;
      this.queue.shift();
      this.dispatch(slot, job);
    }
  }
  private dispatch(slot: Slot, job: Job) {
    if (
      job.invocation?.generation &&
      job.invocation.generation !== slot.generation
    ) {
      clearTimeout(job.timer);
      job.reject(new Error("plugin target generation replaced"));
      return;
    }
    job.context = executionContext(
      job.kind === "dispose" ? "disposal" : "invocation",
      job.pre,
      job.invocation?.causal,
    );
    slot.contexts.set(job.context.reference.id, job.context);
    // pump owns lane eligibility; an admitted guard never supersedes another.
    if (job.pre && this.role === "service") {
      slot.activeGuard = job;
    } else {
      slot.active = job;
    }
    slot.lastDispatch = Date.now();
    const common = {
      generation: slot.generation,
      id: job.id,
      context: job.context.reference,
    };
    const message: HostMessage = job.kind === "invoke"
      ? {
        type: "invoke",
        ...common,
        handlerId: job.name,
        args: job.args,
        pre: job.pre,
      }
      : job.kind === "dispose"
      ? { type: "dispose", ...common }
      : { type: "call", ...common, fn: job.name, args: job.args };
    slot.worker.postMessage(message);
  }
  /** FIFO broadcast reserves every replica's sync boundary before later renders. */
  async syncAll(): Promise<void> {
    const jobs = this.slots.filter((slot) => slot.exports.has("onSync")).map((
      slot,
    ) =>
      this.enqueue("call", "onSync", [], false, this.limits.serviceCallMs, slot)
        .then(() => {
          slot.usable = true;
        }, () => {
          slot.usable = false;
          logger.error(`plugin '${this.manifest.id}' onSync failed`);
        })
    );
    await Promise.all(jobs);
  }
  async respawnAll(): Promise<void> {
    this.stop();
    await this.start();
  }
  /** Exactly-once authority/resource retirement; no replacement can borrow it. */
  private retireSlot(slot: Slot, detail: string): void {
    if (slot.retired) return;
    slot.retired = true;
    slot.retireGeneration();
    clearTimeout(slot.bootTimer);
    slot.background.close({ status: "aborted" });
    for (const context of slot.contexts.values()) {
      context.close({ status: "aborted" });
    }
    slot.contexts.clear();
    for (const receipt of slot.receipts.values()) {
      clearTimeout(receipt.timer);
      receipt.context.close({ status: "aborted" });
    }
    slot.receipts.clear();
    slot.worker.terminate();
    slot.rejectReady(new Error(detail));
    if (slot.active) {
      clearTimeout(slot.active.timer);
      slot.active.reject(new Error(detail));
      slot.active = null;
    }
    if (slot.activeGuard) {
      clearTimeout(slot.activeGuard.timer);
      slot.activeGuard.reject(new Error(detail));
      slot.activeGuard = null;
    }
    slot.ready = false;
    slot.usable = false;
  }
  private rejectQueued(detail: string): void {
    for (const job of [...this.queue.splice(0), ...this.guardQueue.splice(0)]) {
      clearTimeout(job.timer);
      job.reject(new Error(detail));
    }
  }
  private reportFailure(detail: string): void {
    try {
      this.options.registrationChanged?.();
    } catch (error) {
      logger.error(
        `plugin '${this.manifest.id}' failure invalidation failed: ${error}`,
      );
    }
    try {
      this.options.failed?.(detail);
    } catch (error) {
      logger.error(
        `plugin '${this.manifest.id}' failure diagnostic failed: ${error}`,
      );
    }
  }
  private failRenderPool(detail: string): void {
    this.failedDetail = detail;
    this.stop();
    this.reportFailure(detail);
  }
  private async recoverRender(
    previous: Slot,
    identity: object | undefined,
    ticket: object,
  ): Promise<void> {
    const current = () =>
      this.startIdentity === identity && !this.stopped && !this.stopping &&
      this.renderRecoveries.has(ticket);
    let candidate: Slot | undefined;
    try {
      const captured: RenderRecoveryAdmission = {
        source: previous.source,
        effective: structuredClone(previous.permissions),
        writable: this.options.writable,
      };
      const admitted = this.options.renderRecovery
        ? await this.options.renderRecovery(captured)
        : captured;
      if (!current()) return;
      candidate = this.spawn(admitted);
      if (!current()) {
        this.retireSlot(candidate, "render recovery retired before admission");
        return;
      }
      this.slots.push(candidate);
      this.renderRecoveries.set(ticket, true);
      await candidate.readyPromise;
      if (!current()) {
        this.retireSlot(
          candidate,
          "render recovery superseded before readiness",
        );
      }
    } catch (error) {
      if (candidate) {
        const index = this.slots.indexOf(candidate);
        if (index >= 0) this.slots.splice(index, 1);
        this.retireSlot(candidate, "render recovery failed");
      }
      if (current()) {
        this.failRenderPool(
          error instanceof Error ? error.message : "render recovery failed",
        );
      }
    } finally {
      this.renderRecoveries.delete(ticket);
      if (
        this.startIdentity === identity && !this.stopped && !this.failedDetail
      ) {
        this.pump();
        this.options.registrationChanged?.();
      }
    }
  }
  private fail(slot: Slot, detail: string) {
    if (!this.valid(slot)) return;
    const recoverable = this.role === "render" && slot.ready;
    const identity = this.startIdentity;
    if (this.role === "render") this.slots.splice(this.slots.indexOf(slot), 1);
    this.retireSlot(slot, detail);
    if (this.role === "service") {
      this.failedDetail = detail;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      this.registry.clear();
      this.rejectQueued(detail);
      this.reportFailure(detail);
    } else {
      this.rejectQueued(
        "worker generation replaced; queued work was not replayed",
      );
      if (!recoverable) {
        this.failRenderPool(detail);
        return;
      }
      const ticket = {};
      this.renderRecoveries.set(ticket, false);
      // Old authority and work are already dead before the first recovery await.
      this.recoverRender(slot, identity, ticket).catch((error) => {
        if (this.startIdentity === identity && !this.stopped) {
          this.failRenderPool(`render recovery callback failed: ${error}`);
        }
      });
    }
  }
  private checkHeartbeats() {
    for (const slot of this.slots) {
      if (this.role === "service" && this.failedDetail) return;
      const timeout = slot.provenAlive
        ? 3 * HEARTBEAT_MS
        : this.limits.activationMs;
      if (Date.now() - slot.lastHeartbeat > timeout) {
        this.fail(slot, "worker heartbeat timeout; in-flight outcome unknown");
      }
    }
  }
  async dispose(): Promise<{ unfinished: number; errors: unknown[] }> {
    this.stopping = true;
    for (const slot of this.slots) {
      slot.retireGeneration();
      slot.background.close({ status: "aborted" });
      for (const context of slot.contexts.values()) {
        context.close({ status: "aborted" });
      }
    }
    const errors: unknown[] = [];
    const cancelled = [
      ...this.guardQueue.splice(0),
      ...this.queue.filter((job) => job.pre),
    ];
    this.queue = this.queue.filter((job) => !job.pre);
    for (const job of cancelled) {
      clearTimeout(job.timer);
      job.reject(new Error("plugin guard owner disabled before execution"));
    }
    let unfinished = cancelled.length;
    const deadline = Date.now() + this.limits.disposalMs;
    this.pump();
    for (const slot of this.slots) {
      if (slot.activeGuard) {
        clearTimeout(slot.activeGuard.timer);
        slot.activeGuard.reject(new Error("plugin guard owner disabled"));
        slot.activeGuard = null;
        unfinished++;
      }
      while ((slot.active || this.queue.length) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (slot.active || this.queue.length) {
        unfinished += (slot.active ? 1 : 0) + this.queue.length;
        continue;
      }
      if (slot.ready && !this.failedDetail) {
        try {
          const result = await this.enqueue(
            "dispose",
            "",
            [],
            false,
            Math.max(1, deadline - Date.now()),
            slot,
          ) as { errors: unknown[] };
          errors.push(...result.errors);
        } catch {
          errors.push("plugin disposal failed or exceeded its deadline");
        }
      }
    }
    this.stop();
    return { unfinished, errors };
  }
  stop(): void {
    this.startIdentity = undefined;
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.renderRecoveries.clear();
    for (const slot of this.slots) {
      this.retireSlot(slot, "plugin host stopped");
    }
    this.rejectQueued("plugin host stopped");
    this.slots = [];
    this.registry.clear();
  }
}
