// SPDX-License-Identifier: LGPL-3.0-only
import { connectionLifetime } from "./connectionLifetime.js";

/** Failed snapshot reads own their retry; unchanged metadata is not a retry
 * clock. No writes, review acceptance or draft decisions happen here. */
export function createConflictReadRetry(refresh, { lifetime = connectionLifetime,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) } = {}) {
  let active = lifetime.state().active, timer = null, wanted = false, attempts = 0, delay = 0, disposed = false;
  const pause = () => { clearTimer(timer); timer = null; };
  function arm() {
    if (disposed || !active || !wanted || timer !== null) return;
    timer = setTimer(() => { timer = null; wanted = false; refresh(); }, delay);
  }
  const stop = lifetime.subscribe(next => { active = next; if (next) arm(); else pause(); });
  function begin() { pause(); wanted = false; }
  function reset() { begin(); attempts = 0; }
  return {
    begin, reset,
    failed(error) {
      const status = error?.response?.status;
      // Rejected authority/identity is not repaired by repeating a read.
      if (status && status < 500 && status !== 408 && status !== 429) return;
      delay = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6));
      wanted = true; arm();
    },
    dispose() { disposed = true; reset(); stop(); },
  };
}
