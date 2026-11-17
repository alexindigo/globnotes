// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { NATIVE_SCHEDULER, ObservedClock } from "../server/observed_time.ts";
import { manualExpiry } from "./helpers/manual_deadline.ts";

Deno.test("manual expiry: releases the real deadline timer and held clock interval before the callback", () => {
  const timers = new Set<ReturnType<typeof setTimeout>>(),
    intervals = new Set<ReturnType<typeof setInterval>>();
  const clock = new ObservedClock({
    ...NATIVE_SCHEDULER,
    setTimeout(callback, ms) {
      const id = setTimeout(callback, ms);
      timers.add(id);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
      clearTimeout(id);
    },
    setInterval(callback, ms) {
      const id = setInterval(callback, ms);
      intervals.add(id);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
      clearInterval(id);
    },
  });
  let called = 0;
  const callback = () => {
    assertEquals(timers.size, 0);
    assertEquals(intervals.size, 0);
    called++;
  };
  const cancel = clock.deadline(30_000, callback);
  try {
    assertEquals([timers.size, intervals.size], [1, 1]);
    manualExpiry(cancel, callback)();
    assertEquals(called, 1);
  } finally {
    cancel();
  }
});
