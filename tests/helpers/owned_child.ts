// SPDX-License-Identifier: LGPL-3.0-only
import { type FixtureScope, fixtureScope } from "./fixture_scope.ts";
import type { OwnedResource } from "../../shared/ownership.js";
import {
  type ChildOptions,
  spawnCommand,
  spawnCommandGroup,
} from "./process.ts";

/** Low-level scheduling port for contract controls, never a whole-driver clock. */
export interface ChildSignalClock {
  set(callback: () => void, milliseconds: number): () => void;
}
const clock: ChildSignalClock = {
  set(callback, milliseconds) {
    const timer = globalThis.setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

export interface OwnedChild {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<Deno.CommandStatus>;
  status(): Deno.CommandStatus | null;
  signal(signal: Deno.Signal): boolean;
  signalAfter(milliseconds: number, signal: Deno.Signal): () => void;
  terminate(graceMs: number): Promise<Deno.CommandStatus>;
  reap(): Promise<Deno.CommandStatus>;
}

/** Own a finite command and its output together. Exit of the direct child
 * alone does not retire this owner: descendants can still hold its pipes. */
export async function captureOwnedCommand(
  scope: FixtureScope,
  program: string | URL,
  options: Pick<ChildOptions, "args" | "cwd" | "env">,
) {
  return (await scope.admit(async (signal) => {
    let running: ReturnType<typeof spawnCommandGroup> | undefined;
    scope.onCancel(() => running?.kill());
    running = spawnCommandGroup(program, options, signal);
    const { child } = running;
    let output;
    try {
      // Native spawn can still read arguments after the pre-spawn fence. If
      // that retires the scope, the hook fired before it could see the group.
      if (signal.aborted) running.kill();
    } finally {
      output = await Promise.allSettled([
        child.status,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      running = undefined;
    }
    const [status, stdout, stderr] = output;
    signal.throwIfAborted();
    if (status.status === "rejected") throw status.reason;
    if (stdout.status === "rejected") throw stdout.reason;
    if (stderr.status === "rejected") throw stderr.reason;
    return { status: status.value, stdout: stdout.value, stderr: stderr.value };
  })).value;
}

/** Only child execution is owned here. Pipe consumption and mandatory result
 * collection remain separate caller tasks; status is never inferred from EOF.
 * P03 reserves custody BEFORE spawn, including rejection before a handle escapes.
 */
export function spawnOwnedChild(
  scope: FixtureScope,
  program: string | URL,
  options: ChildOptions,
  scheduler: ChildSignalClock = clock,
): Promise<OwnedResource<OwnedChild>> {
  // Reserve the child before touching its status observer or cancellation hook.
  // Those setup steps can throw; no returned handle is needed for cleanup.
  let start: () => void;
  let release: () => Promise<void>;
  const acquired = scope.acquire(() => {
    const launchOptions = { ...options };
    // Admission must fence caller getters before they run, and acquisition
    // keeps their failures on the same rejection channel as spawn failures.
    const setSignal = scheduler.set.bind(scheduler);
    // If native spawn itself retires the scope, the reserved acquisition's
    // disposer reaps and closes the unclaimed pipes before it rejects.
    const child = spawnCommand(program, launchOptions, scope.signal);
    const timers = new Set<() => void>();
    let settled = false, status: Deno.CommandStatus | null = null;
    const retire = () => {
      settled = true;
      for (const cancel of [...timers]) cancel();
    };
    let exited: Promise<Deno.CommandStatus> | undefined;
    const signal = (signo: Deno.Signal): boolean => {
      if (settled) return false;
      try {
        child.kill(signo);
        return true;
      } catch (error) {
        // The OS can reap the child before its status reaction runs.
        if (
          error instanceof Deno.errors.NotFound ||
          error instanceof TypeError &&
            error.message === "Child process has already terminated"
        ) return false;
        throw error;
      }
    };
    const signalAfter = (milliseconds: number, signo: Deno.Signal) => {
      if (settled) return () => {};
      let active = true, clearing = false, clear = () => {};
      const cancel = () => {
        if (clearing || !timers.has(cancel)) return;
        active = false;
        clearing = true;
        try {
          clear();
          timers.delete(cancel);
        } finally {
          // Reentrant cancellation joins this clear; a failed clear remains
          // tracked so a later independent cancellation can retry it.
          clearing = false;
        }
      };
      timers.add(cancel);
      try {
        clear = setSignal(() => {
          if (!active || settled) return;
          cancel();
          signal(signo);
        }, milliseconds);
        if (!active) clear(); // Also supports a synchronously firing scheduler.
      } catch (error) {
        cancel();
        throw error;
      }
      return cancel;
    };
    let terminating: Promise<Deno.CommandStatus> | undefined;
    const reap = async () => {
      signal("SIGKILL");
      return await (exited ?? child.status);
    };
    let releasing: Promise<void> | undefined;
    let started = false;
    release = () =>
      releasing ??= fixtureScope((cleanup) => {
        // stdin is a separate resource, even after actual process exit. Native
        // close may reject if the caller already used it as an explicit trigger.
        if (launchOptions.stdin === "piped") {
          cleanup.defer(() => child.stdin.close().catch(() => {}));
        }
        // No caller received the failed acquisition's read ends. Successful
        // callers, including boot's existing drains, retain pipe consumption.
        if (!started) {
          if (launchOptions.stdout === "piped") {
            cleanup.defer(() => child.stdout.cancel());
          }
          if (launchOptions.stderr === "piped") {
            cleanup.defer(() => child.stderr.cancel());
          }
        }
        cleanup.defer(reap);
      });
    const owned = Object.freeze({
      pid: child.pid,
      get stdin() {
        return child.stdin;
      },
      get stdout() {
        return child.stdout;
      },
      get stderr() {
        return child.stderr;
      },
      get exited() {
        return exited!;
      },
      status: () => status,
      signal,
      signalAfter,
      terminate(graceMs: number) {
        return terminating ??= (async () => {
          if (settled) return await exited!;
          const cancel = signalAfter(graceMs, "SIGKILL");
          try {
            signal("SIGTERM");
            return await exited!;
          } finally {
            cancel();
          }
        })();
      },
      reap,
    });
    start = () => {
      scope.assertCurrent();
      exited = child.status;
      // Record actual status in the first native callback; expose the same
      // promise, not another hop that can delay the consumer's exit barrier.
      exited.then((value) => {
        status = value;
        retire();
      }, () => retire());
      // Terminate before admitted child work drains. Pipe release stays in the
      // acquisition disposer, including failed observer/hook construction.
      scope.onCancel(reap);
      started = true;
    };
    return owned;
  }, () => release());
  return acquired.then(async (handle) => {
    try {
      start();
      return handle;
    } catch (error) {
      return await fixtureScope((cleanup) => {
        cleanup.defer(release);
        throw error;
      });
    }
  });
}
