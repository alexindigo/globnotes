// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Plugin host — owns the sandboxed Workers for one plugin.
 *
 * N=2 warm Workers (GLOBNOTES_RENDER_WORKERS), one call at a time per
 * Worker. Heartbeat dispatch: every 250ms each Worker pings; the host
 * tracks `last` heartbeat per slot; a slot silent for 3× the interval
 * is terminated and respawned, with its in-flight calls rejected.
 *
 * Dispatch = least-recently-used idle slot; when every slot is busy,
 * calls queue FIFO and run as slots free.
 */

import * as path from "@std/path";
import { logger } from "../logger.ts";
import type { PluginManifest } from "./manifest.ts";
import { workerPermissions } from "./manifest.ts";

const HEARTBEAT_MS = 250;
const HEARTBEAT_TIMEOUT = 3 * HEARTBEAT_MS;
/** Cold boots (TS compile + plugin import) get a longer leash; the
 * strict 3×T rule only applies once a worker has proven it's alive. */
const BOOT_GRACE_MS = 10_000;
const WORKER_URL = new URL("./worker_entry.ts", import.meta.url);

export type RpcHandler = (
  method: string,
  args: unknown[],
) => Promise<unknown>;

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class WorkerSlot {
  worker: Worker | null = null;
  ready = false;
  busy = false;
  lastHeartbeat = 0;
  /** False until the first heartbeat — distinguishes "slow to boot"
   * from "alive then hung". */
  everHeartbeated = false;
  lastDispatch = 0;
  seq = 0;
  readonly pending = new Map<number, PendingCall>();
  /** Waiters parked on "ready". */
  readyWaiters: PendingCall[] = [];

  rejectAll(reason: string): void {
    for (const p of this.pending.values()) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
    for (const w of this.readyWaiters) {
      w.reject(new Error(reason));
    }
    this.readyWaiters = [];
  }
}

export class PluginHost {
  readonly manifest: PluginManifest;
  private readonly vaultPath: string;
  private readonly rpc: RpcHandler;
  private readonly workerCount: number;
  private slots: WorkerSlot[] = [];
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private queue: {
    fn: string;
    args: unknown[];
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }[] = [];

  constructor(
    manifest: PluginManifest,
    vaultPath: string,
    rpc: RpcHandler,
    workerCount: number,
  ) {
    this.manifest = manifest;
    this.vaultPath = vaultPath;
    this.rpc = rpc;
    this.workerCount = workerCount;
  }

  /** Spawn all workers; resolves when every slot has signalled ready
   * (or rejected on spawn failure). */
  async start(): Promise<void> {
    this.stopped = false;
    this.slots = Array.from(
      { length: this.workerCount },
      () => new WorkerSlot(),
    );
    for (const slot of this.slots) this.#spawn(slot);
    this.watchdog = setInterval(() => this.#checkHeartbeats(), HEARTBEAT_MS);
    await Promise.all(this.slots.map((s) => this.#waitReady(s)));
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog !== null) clearInterval(this.watchdog);
    for (const slot of this.slots) {
      slot.worker?.terminate();
      slot.rejectAll("plugin host stopped");
    }
    this.slots = [];
    for (const q of this.queue.splice(0)) {
      q.reject(new Error("plugin host stopped"));
    }
  }

  /** Terminate every worker and spawn fresh ones (plan: "reinstantiate
   * on every sync; state resets"). */
  async respawnAll(): Promise<void> {
    for (const slot of this.slots) {
      slot.worker?.terminate();
      slot.ready = false;
      slot.rejectAll("worker respawned");
      this.#spawn(slot);
    }
    await Promise.all(this.slots.map((s) => this.#waitReady(s)));
  }

  /** Call a plugin export (getSelectors / parseNode / onSync) on the
   * least-recently-used idle worker; queues when all are busy. */
  call(fn: string, args: unknown[]): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(new Error("plugin host stopped"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, args, resolve, reject });
      this.#pump();
    });
  }

  #pump(): void {
    while (this.queue.length > 0) {
      const slot = this.#pickSlot();
      if (!slot) return; // all busy
      const job = this.queue.shift()!;
      this.#dispatch(slot, job.fn, job.args)
        .then(job.resolve, job.reject)
        .finally(() => this.#pump());
    }
  }

  #pickSlot(): WorkerSlot | null {
    let best: WorkerSlot | null = null;
    for (const slot of this.slots) {
      if (slot.busy || !slot.ready) continue;
      if (!best || slot.lastDispatch < best.lastDispatch) best = slot;
    }
    return best;
  }

  async #dispatch(
    slot: WorkerSlot,
    fn: string,
    args: unknown[],
  ): Promise<unknown> {
    slot.busy = true;
    slot.lastDispatch = Date.now();
    const id = ++slot.seq;
    try {
      return await new Promise((resolve, reject) => {
        slot.pending.set(id, { resolve, reject });
        slot.worker!.postMessage({ type: "call", id, fn, args });
      });
    } finally {
      slot.busy = false;
    }
  }

  #waitReady(slot: WorkerSlot): Promise<void> {
    if (slot.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      slot.readyWaiters.push({ resolve: () => resolve(undefined), reject });
    });
  }

  #spawn(slot: WorkerSlot): void {
    const worker = new Worker(WORKER_URL, {
      type: "module",
      deno: {
        permissions: workerPermissions(this.manifest, this.vaultPath),
      },
    });
    slot.worker = worker;
    slot.lastHeartbeat = Date.now();
    slot.everHeartbeated = false;
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "heartbeat") {
        slot.lastHeartbeat = Date.now();
        slot.everHeartbeated = true;
        return;
      }
      if (msg.type === "ready") {
        slot.ready = true;
        for (const w of slot.readyWaiters.splice(0)) w.resolve(undefined);
        this.#pump();
        return;
      }
      if (msg.type === "initError") {
        // Disable the slot; reject every waiter so start() fails instead
        // of hanging on a permanently broken plugin.
        logger.error(
          `plugin '${this.manifest.id}' failed to load: ${msg.value}`,
        );
        slot.rejectAll(`plugin failed to load: ${msg.value}`);
        return;
      }
      if (msg.type === "result") {
        const p = slot.pending.get(msg.id);
        if (p) {
          slot.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(new Error(String(msg.value)));
        }
        return;
      }
      if (msg.type === "rpc") {
        this.rpc(msg.method, msg.args).then(
          (value) =>
            worker.postMessage({
              type: "rpcResponse",
              id: msg.id,
              ok: true,
              value,
            }),
          (e) =>
            worker.postMessage({
              type: "rpcResponse",
              id: msg.id,
              ok: false,
              value: e instanceof Error ? e.message : String(e),
            }),
        );
      }
    };
    worker.onerror = (e) => {
      logger.error(
        `plugin '${this.manifest.id}' worker error: ${e.message}`,
      );
    };
    const pluginUrl = path.toFileUrl(
      path.join(this.manifest.dir, this.manifest.entry),
    ).href;
    worker.postMessage({ type: "init", pluginUrl });
  }

  #checkHeartbeats(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const slot of this.slots) {
      const timeout = slot.everHeartbeated ? HEARTBEAT_TIMEOUT : BOOT_GRACE_MS;
      if (now - slot.lastHeartbeat <= timeout) continue;
      logger.warning(
        `plugin '${this.manifest.id}' worker silent for >${timeout}ms; respawning`,
      );
      slot.worker?.terminate();
      slot.ready = false;
      slot.rejectAll("worker heartbeat timeout");
      this.#spawn(slot);
    }
  }
}
