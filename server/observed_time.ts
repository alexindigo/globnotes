// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The single owner of "elapsed time this process actually observed"
 * (plans/scheduling-tolerance). A homelab host can stop running globnotes for
 * a while: a NAS during a backup or scrub, a paused VM, swap-in, or the
 * server's own synchronous work blocking the event loop. A liveness or
 * deadline check that measures raw time across such a period blames the
 * watched party for time in which the checker itself was not running.
 *
 * The clock ticks every `periodMs` while anyone measures with it. Each tick
 * credits the time since the previous one, at most `periodMs + toleranceMs`:
 * a longer gap is a stall of this process and its excess is not counted.
 * Between ticks, `now()` credits at most the same cap. Every product budget
 * (heartbeat silence, activation, call, guard, disposal, receipt, plugin
 * filesystem and request-body deadlines) reads this clock instead of
 * `Date.now()` / `performance.now()`; tests/test_isolation_contract_test.ts
 * enforces that. Wall-clock properties such as credential expiry stay on
 * `Date.now()`.
 */

import { logger } from "./logger.ts";

/** Monotonic time source and timers; tests inject a stepping fake. */
export interface MonotonicScheduler {
  now(): number;
  setTimeout(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  setInterval(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
}

export const NATIVE_SCHEDULER: MonotonicScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (id) => clearInterval(id),
};

/** The watchdog cadence: one heartbeat period. */
export const OBSERVED_PERIOD_MS = 250;
/** Tick lateness still counted as observed time. */
export const OBSERVED_TOLERANCE_MS = 100;
/** Stalls at least this long are logged as warnings; shorter ones at debug. */
export const STALL_WARNING_MS = 750;
/** At most one stall warning per this interval; later ones are counted. */
export const STALL_WARNING_INTERVAL_MS = 10_000;

export interface StallReport {
  /** Gap between two consecutive observations of the clock. */
  gapMs: number;
  /** Part of the gap that was not counted as observed time. */
  discountedMs: number;
}
export interface StallStatistics {
  count: number;
  totalDiscountedMs: number;
  last: StallReport | null;
  /** Observed time at which the last stall ended. */
  lastAt: number | null;
}

function logStall(): (stall: StallReport) => void {
  let lastWarning = -Infinity, suppressed = 0;
  return (stall) => {
    const message = `globnotes was not scheduled for ${
      Math.round(stall.gapMs)
    } ms; ${
      Math.round(stall.discountedMs)
    } ms were not counted against plugin workers or deadlines`;
    if (stall.gapMs < STALL_WARNING_MS) {
      logger.debug(message);
      return;
    }
    const now = NATIVE_SCHEDULER.now();
    if (now - lastWarning < STALL_WARNING_INTERVAL_MS) {
      suppressed++;
      return;
    }
    logger.warning(
      suppressed
        ? `${message} (${suppressed} earlier stalls not logged)`
        : message,
    );
    lastWarning = now;
    suppressed = 0;
  };
}

export class ObservedClock {
  readonly periodMs: number;
  readonly toleranceMs: number;
  readonly #cap: number;
  readonly #report: (stall: StallReport) => void;
  readonly #subscribers = new Set<() => void>();
  #users = 0;
  #interval: ReturnType<typeof setInterval> | null = null;
  #observed = 0;
  #lastRaw: number;
  readonly stalls: StallStatistics = {
    count: 0,
    totalDiscountedMs: 0,
    last: null,
    lastAt: null,
  };

  constructor(
    private readonly scheduler: MonotonicScheduler = NATIVE_SCHEDULER,
    options: {
      periodMs?: number;
      toleranceMs?: number;
      report?: (stall: StallReport) => void;
    } = {},
  ) {
    this.periodMs = options.periodMs ?? OBSERVED_PERIOD_MS;
    this.toleranceMs = options.toleranceMs ?? OBSERVED_TOLERANCE_MS;
    this.#cap = this.periodMs + this.toleranceMs;
    this.#report = options.report ?? logStall();
    this.#lastRaw = scheduler.now();
  }

  /** Observed milliseconds; monotonic. */
  now(): number {
    return this.#observed +
      Math.min(Math.max(0, this.scheduler.now() - this.#lastRaw), this.#cap);
  }

  /** Credit the time since the last observation (at most the cap). */
  #observe(): void {
    const raw = this.scheduler.now(), gap = Math.max(0, raw - this.#lastRaw);
    const credit = Math.min(gap, this.#cap);
    this.#observed += credit;
    this.#lastRaw = raw;
    if (gap > this.#cap) {
      const stall = { gapMs: gap, discountedMs: gap - credit };
      this.stalls.count++;
      this.stalls.totalDiscountedMs += stall.discountedMs;
      this.stalls.last = stall;
      this.stalls.lastAt = this.#observed;
      this.#report(stall);
    }
  }

  /**
   * Long synchronous work that is itself bounded by this clock calls this
   * per unit of work: the process is running and observing time pass, so
   * that time counts.
   */
  observe(): void {
    this.#observe();
  }

  #tick = () => {
    this.#observe();
    for (const subscriber of [...this.#subscribers]) subscriber();
  };

  /** Keep the clock ticking until the returned release is called. */
  hold(): () => void {
    if (this.#users++ === 0) {
      // Idle time before this point was not a measurement.
      this.#observed = this.now();
      this.#lastRaw = this.scheduler.now();
      this.#interval = this.scheduler.setInterval(this.#tick, this.periodMs);
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--this.#users === 0 && this.#interval !== null) {
        this.scheduler.clearInterval(this.#interval);
        this.#interval = null;
      }
    };
  }

  /** Call `onTick` after every tick (one period apart while on time). */
  every(onTick: () => void): () => void {
    const release = this.hold();
    const subscriber = () => onTick();
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
      release();
    };
  }

  /** Expire once `budgetMs` of observed time has passed. */
  deadline(budgetMs: number, onExpire: () => void): () => void {
    return this.deadlineAt(this.now() + Math.max(0, budgetMs), onExpire);
  }

  /** Expire once observed time reaches `until`. A wake-up that a stall made
   * early in observed time re-arms for the remainder. */
  deadlineAt(until: number, onExpire: () => void): () => void {
    const release = this.hold();
    let id: ReturnType<typeof setTimeout> | undefined, settled = false;
    const arm = (milliseconds: number) => {
      id = this.scheduler.setTimeout(() => {
        if (settled) return;
        const remaining = until - this.now();
        if (remaining > 0) {
          arm(remaining);
          return;
        }
        settled = true;
        release();
        onExpire();
      }, milliseconds);
    };
    arm(Math.max(0, until - this.now()));
    return () => {
      if (settled) return;
      settled = true;
      if (id !== undefined) this.scheduler.clearTimeout(id);
      release();
    };
  }
}

/** The process-wide clock every product budget uses by default. */
export const processClock = new ObservedClock();
