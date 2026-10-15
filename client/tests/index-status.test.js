// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createIndexStatus } from "../indexStatus.js";
import { getIndexStatus } from "../api.js";
import { refreshNoteIndex } from "../noteIndex.js";

vi.mock("../api.js", () => ({ getIndexStatus: vi.fn() }));
vi.mock("../noteIndex.js", () => ({ refreshNoteIndex: vi.fn() }));

const idle = { syncing: false, done: 0, total: 0 };
const active = { syncing: true, done: 2, total: 10 };
let controllers = [];
function setup(adapters = {}) {
  const s = { loadStatus: vi.fn().mockResolvedValue(active), refreshIndex: vi.fn(), schedule: vi.fn().mockReturnValue(42), cancel: vi.fn(), ...adapters };
  const controller = createIndexStatus(s);
  controllers.push(controller);
  return { ...s, controller };
}

describe("index status polling", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { controllers.forEach(c => c.dispose()); controllers = []; });

  it("starts idle, binds default adapters and does not poll when already idle", async () => {
    getIndexStatus.mockResolvedValueOnce(idle);
    const s = setup({ loadStatus: getIndexStatus, refreshIndex: refreshNoteIndex });
    expect(s.controller.snapshot()).toEqual(idle);
    await s.controller.poll();
    expect(getIndexStatus).toHaveBeenCalledOnce();
    expect(s.schedule).not.toHaveBeenCalled();
    expect(refreshNoteIndex).not.toHaveBeenCalled();
  });

  it("starts exactly one 3-second interval and publishes progress for the consumer", async () => {
    const s = setup();
    await s.controller.poll();
    expect(s.controller.snapshot()).toEqual(active);
    expect(s.schedule).toHaveBeenCalledExactlyOnceWith(s.controller.poll, 3000);
    s.loadStatus.mockResolvedValueOnce({ ...active, done: 5 });
    await s.schedule.mock.calls[0][0]();
    expect(s.controller.snapshot().done).toBe(5);
    expect(s.schedule).toHaveBeenCalledOnce();
    expect(s.refreshIndex).not.toHaveBeenCalled();
  });

  it("stops the interval and refreshes the note index only at a syncing-to-idle transition", async () => {
    const s = setup();
    await s.controller.poll(); await nextTick();
    s.loadStatus.mockResolvedValueOnce({ ...idle, done: 10, total: 10 });
    await s.controller.poll(); await nextTick();
    expect(s.cancel).toHaveBeenCalledExactlyOnceWith(42);
    expect(s.refreshIndex).toHaveBeenCalledOnce();
    s.loadStatus.mockResolvedValueOnce(idle);
    await s.controller.poll(); await nextTick();
    expect(s.refreshIndex).toHaveBeenCalledOnce();
    expect(s.cancel).toHaveBeenCalledOnce();
  });

  it("can observe a second sync cycle with a new interval and completion refresh", async () => {
    const s = setup();
    for (const status of [active, idle, active, idle]) {
      s.loadStatus.mockResolvedValueOnce(status);
      await s.controller.poll(); await nextTick();
    }
    expect(s.schedule).toHaveBeenCalledTimes(2);
    expect(s.cancel).toHaveBeenCalledTimes(2);
    expect(s.refreshIndex).toHaveBeenCalledTimes(2);
  });

  it("disposes the polling timer and the completion watcher", async () => {
    const s = setup();
    await s.controller.poll(); await nextTick();
    s.controller.dispose();
    expect(s.cancel).toHaveBeenCalledWith(42);
    s.loadStatus.mockResolvedValueOnce(idle);
    await s.controller.poll(); await nextTick();
    expect(s.refreshIndex).not.toHaveBeenCalled();
  });

  it("contains an initial read rejection and reports it without inventing sync progress", async () => {
    const error = new Error("initial status unavailable");
    const s = setup({ loadStatus: vi.fn().mockRejectedValue(error), reportError: vi.fn() });
    await expect(s.controller.poll()).resolves.toBeUndefined();
    expect(s.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(s.controller.snapshot()).toEqual(idle);
    expect(s.schedule).not.toHaveBeenCalled();
    expect(s.refreshIndex).not.toHaveBeenCalled();
  });

  it("contains interval rejections, retains progress and keeps polling until observed completion", async () => {
    const error = new Error("status offline");
    const s = setup({ reportError: vi.fn() });
    await s.controller.poll(); await nextTick();
    s.loadStatus.mockRejectedValueOnce(error);
    const tick = s.schedule.mock.calls[0][0];
    await expect(tick()).resolves.toBeUndefined(); await nextTick();
    expect(s.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(s.controller.snapshot()).toEqual(active);
    expect(s.cancel).not.toHaveBeenCalled();
    expect(s.refreshIndex).not.toHaveBeenCalled();
    s.loadStatus.mockResolvedValueOnce({ ...idle, done: 10, total: 10 });
    await tick(); await nextTick();
    expect(s.cancel).toHaveBeenCalledExactlyOnceWith(42);
    expect(s.refreshIndex).toHaveBeenCalledOnce();
  });

  it("contains synchronous adapter throws through the same polling boundary", async () => {
    const error = new Error("adapter failed");
    const s = setup({ loadStatus: () => { throw error; }, reportError: vi.fn() });
    await expect(s.controller.poll()).resolves.toBeUndefined();
    expect(s.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(s.controller.snapshot()).toEqual(idle);
  });

  it("reports polling failures with the default diagnostic adapter", async () => {
    const error = new Error("transport failed");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = setup({ loadStatus: vi.fn().mockRejectedValue(error) });
      await expect(s.controller.poll()).resolves.toBeUndefined();
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith("[indexStatus] poll failed", error);
    } finally {
      diagnostic.mockRestore();
    }
  });
});
