import { afterEach, expect, it, vi } from "vitest";
import { createConflictReadRetry } from "../conflictReadRetry.js";
import { createConnectionLifetime, HIDDEN_GRACE_MS } from "../connectionLifetime.js";

afterEach(() => vi.useRealTimers());

it("backs off failed reads, resets on success and retires scheduled work", async () => {
  vi.useFakeTimers(); const refresh = vi.fn(), retry = createConflictReadRetry(refresh);
  try {
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = refresh.mock.calls.length; retry.failed(Error("offline"));
      await vi.advanceTimersByTimeAsync(delay - 1); expect(refresh).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1); expect(refresh).toHaveBeenCalledTimes(before + 1);
    }
    retry.reset(); retry.failed(Error("offline")); await vi.advanceTimersByTimeAsync(500);
    expect(refresh).toHaveBeenCalledTimes(9);
    retry.failed(Error("offline")); retry.begin(); await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(9);
    retry.failed(Error("offline")); retry.dispose(); await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(9);
  } finally { retry.dispose(); }
});

it("pauses failed reads while the page is inactive and resumes only pending recovery", async () => {
  vi.useFakeTimers(); const lifetime = createConnectionLifetime(), refresh = vi.fn();
  const retry = createConflictReadRetry(refresh, { lifetime });
  try {
    lifetime.setVisible(false); await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS);
    retry.failed(Error("offline")); await vi.advanceTimersByTimeAsync(30000); expect(refresh).not.toHaveBeenCalled();
    lifetime.setVisible(true); await vi.advanceTimersByTimeAsync(500); expect(refresh).toHaveBeenCalledTimes(1);
    retry.reset(); lifetime.suspendDocument(); lifetime.resumeDocument(); await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(1);
    retry.failed(Error("offline")); lifetime.suspendDocument(); await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(1);
    lifetime.resumeDocument(); await vi.advanceTimersByTimeAsync(500); expect(refresh).toHaveBeenCalledTimes(2);
  } finally { retry.dispose(); }
});

it("leaves definitive read rejections to explicit authority/identity recovery", async () => {
  vi.useFakeTimers(); const refresh = vi.fn(), retry = createConflictReadRetry(refresh);
  try {
    for (const status of [400, 401, 403, 404]) retry.failed({ response: { status } });
    await vi.advanceTimersByTimeAsync(30000); expect(refresh).not.toHaveBeenCalled();
    for (const status of [408, 429, 503]) {
      retry.reset(); retry.failed({ response: { status } }); await vi.advanceTimersByTimeAsync(500);
    }
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally { retry.dispose(); }
});
