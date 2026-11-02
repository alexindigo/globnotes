// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The one readiness wait for tests (server tests and the browser suite).
 *
 * A readiness wait polls until a fixture, server, plugin or page reaches a
 * state the test needs before it exercises the behaviour under test. How
 * long that takes is not the behaviour under test: a test whose subject is
 * timing asserts its own budget explicitly (tests/timing/). A readiness
 * wait's bound is only a safety net, so it is one constant, READINESS_MS,
 * sized like the server launcher's readiness bound (tests/helpers/boot.ts
 * uses the same constant) and longer than every product deadline a probe
 * waits on (plugin activation, PLUGIN_LIMITS.activationMs): the product,
 * not an ad-hoc harness cap, gives the verdict.
 *
 * A probe reports one observation per poll:
 *   done(value)            the awaited state is reached;
 *   pending(state)         not yet, with what it observed;
 *   failed(reason, state)  a terminal state (a failed plugin, a rejected
 *                          request): the wait fails at once.
 * A probe that throws fails the wait at once. Every failure names the wait
 * (its label), the reason and the last observed state of everything the
 * probe looked at. Child processes the state depends on can be passed as
 * `children`; one that exits fails the wait at once.
 *
 * tests/test_isolation_contract_test.ts rejects ad-hoc deadline arithmetic
 * (`= Date.now() + n`) outside this file.
 */

/** The readiness safety net for every wait in the test suites. */
export const READINESS_MS = 15_000;

const EXPIRED = Symbol("readiness bound exceeded");

export type Observation<T> =
  | { kind: "done"; value: T }
  | { kind: "pending"; state: unknown }
  | { kind: "failed"; reason: string; state: unknown };

export function done(): Observation<undefined>;
export function done<T>(value: T): Observation<T>;
export function done<T>(value?: T): Observation<T | undefined> {
  return { kind: "done", value };
}
export function pending(state: unknown): Observation<never> {
  return { kind: "pending", state };
}
export function failed(reason: string, state: unknown): Observation<never> {
  return { kind: "failed", reason, state };
}

/** A child process whose exit makes the awaited state unreachable. */
export interface WaitChild {
  pid: number;
  /** The exit status once the child has exited, else null. */
  status(): { code: number; signal?: string | null } | null;
  /** The child's captured output, reported on failure when available. */
  logs?(): { stdout?: string; stderr?: string };
}

export interface WaitOptions {
  /** What is awaited, e.g. "plugin 'ep' ready"; leads every failure report. */
  label: string;
  /** Pause between polls (default 25 ms). */
  intervalMs?: number;
  children?: WaitChild[];
}

export class ReadinessError extends Error {
  constructor(
    readonly label: string,
    readonly reason: string,
    readonly state: unknown,
    readonly elapsedMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `${label}: ${reason} after ${elapsedMs} ms (readiness bound ` +
        `${READINESS_MS} ms); last observed state: ${describe(state)}`,
      options,
    );
    this.name = "ReadinessError";
  }
}

/** JSON for failure reports; never throws (cycles, bigint, errors). */
export function describe(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return `${item}n`;
      if (item instanceof Error) {
        return { error: item.name, message: item.message };
      }
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

const tail = (text: string | undefined) =>
  text === undefined ? undefined : text.slice(-4000);

/** Poll `probe` until it reports done; see the module comment. */
export async function waitUntil<T>(
  probe: (signal: AbortSignal) => Observation<T> | Promise<Observation<T>>,
  options: WaitOptions,
): Promise<T> {
  const { label, intervalMs = 25, children = [] } = options;
  const started = Date.now();
  const deadline = started + READINESS_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label}: readiness bound exceeded`));
      resolve(EXPIRED);
    }, READINESS_MS);
  });
  let last: unknown = "nothing observed yet";
  const fail = (reason: string, state: unknown, cause?: unknown): never => {
    throw new ReadinessError(
      label,
      reason,
      state,
      Date.now() - started,
      cause === undefined ? undefined : { cause },
    );
  };
  const exitedChild = () => {
    for (const child of children) {
      const status = child.status();
      if (status) {
        const output = child.logs?.();
        fail(
          `child exited (pid ${child.pid}, exit code ${status.code}${
            status.signal ? `, signal ${status.signal}` : ""
          })`,
          {
            last,
            stdout: tail(output?.stdout),
            stderr: tail(output?.stderr),
          },
        );
      }
    }
  };
  const exceeded = (): never => fail("readiness bound exceeded", last);
  try {
    for (;;) {
      exitedChild();
      let observed: Observation<T> | typeof EXPIRED;
      try {
        const attempt = Promise.resolve().then(() => probe(controller.signal));
        // A probe still running when the bound expires settles unobserved.
        attempt.catch(() => {});
        observed = await Promise.race([attempt, expired]);
      } catch (error) {
        if (controller.signal.aborted) exceeded();
        exitedChild();
        return fail(
          `probe failed: ${error instanceof Error ? error.message : error}`,
          last,
          error,
        );
      }
      if (observed === EXPIRED) exceeded();
      const observation = observed as Observation<T>;
      if (observation.kind === "done") return observation.value;
      if (observation.kind === "failed") {
        exitedChild();
        fail(observation.reason, observation.state);
      }
      last = (observation as { state: unknown }).state;
      if (Date.now() >= deadline) exceeded();
      let pause: ReturnType<typeof setTimeout> | undefined;
      const paused = await Promise.race([
        new Promise<void>((resolve) => pause = setTimeout(resolve, intervalMs)),
        expired,
      ]);
      clearTimeout(pause);
      if (paused === EXPIRED) exceeded();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A WaitChild for a spawned child process (e.g. `Deno.ChildProcess`):
 * tracks its exit status as it happens. */
export function watchChild(
  child: {
    pid: number;
    status: Promise<{ code: number; signal?: string | null }>;
  },
  logs?: () => { stdout?: string; stderr?: string },
): WaitChild {
  let exited: { code: number; signal?: string | null } | null = null;
  child.status.then((status) => exited = status, () => {});
  return { pid: child.pid, status: () => exited, logs };
}
