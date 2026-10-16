// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
import type { WorkerMessage } from "../../server/plugins/contracts.ts";

export async function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`liveness fixture containment: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function until(predicate: () => boolean, label: string) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    assert(performance.now() < end, `liveness fixture containment: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Hold selected real native message deliveries, never replace the Worker or its sender. */
export class WorkerDeliveryGate {
  private readonly native = globalThis.Worker;
  readonly workers: {
    worker: Worker;
    deliver(event: MessageEvent<WorkerMessage>): void;
    held: MessageEvent<WorkerMessage>[];
    received: WorkerMessage[];
    ready?: MessageEvent<WorkerMessage>;
    heartbeatEvent?: MessageEvent<WorkerMessage>;
    terminated: number;
  }[] = [];
  readonly ready = Promise.withResolvers<void>();
  readonly heartbeat = Promise.withResolvers<void>();
  holdHeartbeat = true;
  holdReady = false;
  onConstruct?: () => void;
  constructor() {
    globalThis.Worker = new Proxy(this.native, {
      construct: (target, args, newTarget) => {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        let handler: Worker["onmessage"] = null;
        const item = {
          worker,
          held: [] as MessageEvent<WorkerMessage>[],
          received: [] as WorkerMessage[],
          ready: undefined as MessageEvent<WorkerMessage> | undefined,
          heartbeatEvent: undefined as MessageEvent<WorkerMessage> | undefined,
          terminated: 0,
          deliver(event: MessageEvent<WorkerMessage>) {
            handler?.call(worker, event);
          },
        };
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => {
          item.terminated++;
          terminate();
        };
        Object.defineProperty(worker, "onmessage", {
          configurable: true,
          get: () => handler,
          set(value: Worker["onmessage"]) {
            handler = value;
          },
        });
        worker.addEventListener(
          "message",
          (event: MessageEvent<WorkerMessage>) => {
            item.received.push(event.data);
            if (event.data.type === "heartbeat") {
              item.heartbeatEvent = event;
              if (this.holdHeartbeat) item.held.push(event);
              else item.deliver(event);
              this.heartbeat.resolve();
              return;
            }
            if (event.data.type === "ready") {
              item.ready = event;
              if (!this.holdReady) item.deliver(event);
              this.ready.resolve();
              return;
            }
            item.deliver(event);
          },
        );
        this.workers.push(item);
        this.onConstruct?.();
        return worker;
      },
    });
  }
  releaseHeartbeat(index = 0) {
    const item = this.workers[index];
    const event = item.held.shift();
    assert(
      event && event.data.generation,
      "must release an actual owner-qualified heartbeat",
    );
    item.deliver(event);
  }
  releaseReady(index = 0) {
    const item = this.workers[index];
    assert(item.ready, "must deliver an actual ready descriptor");
    item.deliver(item.ready);
  }
  restore() {
    globalThis.Worker = this.native;
  }
}

/** Only the installed host activation/watchdog callbacks run on this test clock. */
export class LivenessClock {
  time = 0;
  private sequence = 0;
  readonly timeouts = new Map<number, { callback: () => void; due: number }>();
  readonly intervals = new Map<
    number,
    { callback: () => void; milliseconds: number }
  >();
  readonly installed: { kind: string; milliseconds: number }[] = [];
  now = () => this.time;
  setTimeout = (callback: () => void, milliseconds: number) => {
    this.installed.push({ kind: "activation", milliseconds });
    const id = ++this.sequence;
    this.timeouts.set(id, { callback, due: this.time + milliseconds });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (id: ReturnType<typeof setTimeout>) => {
    this.timeouts.delete(id as unknown as number);
  };
  setInterval = (callback: () => void, milliseconds: number) => {
    this.installed.push({ kind: "watchdog", milliseconds });
    const id = ++this.sequence;
    this.intervals.set(id, { callback, milliseconds });
    return id as unknown as ReturnType<typeof setInterval>;
  };
  clearInterval = (id: ReturnType<typeof setInterval>) => {
    this.intervals.delete(id as unknown as number);
  };
  tick(time: number, activation = false) {
    assert(time >= this.time);
    this.time = time;
    assert(
      this.installed.some((row) =>
        row.kind === "watchdog" && row.milliseconds === 250
      ),
      "production watchdog must use injected scheduler",
    );
    if (activation) {
      for (const [id, timer] of [...this.timeouts]) {
        if (timer.due <= time) {
          this.timeouts.delete(id);
          timer.callback();
        }
      }
    }
    for (const timer of [...this.intervals.values()]) timer.callback();
  }
}
