// SPDX-License-Identifier: LGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate, createAutosaveTimer } from "../../plugins/globnotes-autosave-timer/app.js";

function fixture(values = {}, retained = { editing: false, unsaved: false, canSave: false }) {
  const listeners = new Map(), disposers = [];
  let latest = retained;
  const ctx = {
    events: { on: (topic, handler) => {
      listeners.set(topic, handler);
      const snapshot = latest;
      if (topic === "note:edit-state") queueMicrotask(() => {
        if (listeners.get(topic) === handler && latest === snapshot) handler(snapshot);
      });
      return () => listeners.delete(topic);
    } },
    settings: { read: vi.fn().mockResolvedValue({ values: { enabled: true, ...values } }) },
    actions: { dispatch: vi.fn().mockReturnValue(true) },
    timers: {
      setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
      setInterval: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
    },
    register: fn => disposers.push(fn),
  };
  const emit = (topic, value) => {
    if (topic === "edit-state") latest = value;
    listeners.get("note:" + topic)?.(value);
  };
  const state = (unsaved = true, canSave = true) => emit("edit-state", { revision: 1, editing: latest.editing, unsaved, canSave });
  const start = async () => { emit("edit-state", { ...latest, editing: true }); await Promise.resolve(); await Promise.resolve(); };
  const end = () => emit("edit-state", { editing: false, unsaved: false, canSave: false });
  return { ctx, emit, state, start, end, dispose: () => disposers.forEach(fn => fn()) };
}

describe("Autosave timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("activation reads settings but cannot save outside an edit session", async () => {
    const f = fixture();
    await activate(f.ctx);
    f.state();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.ctx.settings.read).toHaveBeenCalledWith("autosave");
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
  });

  it("pause mode restarts on typing, saves only the latest eligible state and stays idle after acceptance", async () => {
    const f = fixture(); await createAutosaveTimer(f.ctx).ready;
    f.state(); await f.start();
    await vi.advanceTimersByTimeAsync(1500); f.state();
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledExactlyOnceWith("editor:save");
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["pause", "interval"])("%s mode does nothing when off", async mode => {
    const f = fixture({ mode, enabled: false }); await createAutosaveTimer(f.ctx).ready;
    await f.start(); f.state(); await vi.advanceTimersByTimeAsync(60000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pause", "interval"])("%s mode waits for a saveable state and skips clean notes", async mode => {
    const f = fixture({ mode, intervalSeconds: 5 }); await createAutosaveTimer(f.ctx).ready;
    await f.start(); f.state(); f.state(false);
    await vi.advanceTimersByTimeAsync(10000);
    f.state(true, false); await vi.advanceTimersByTimeAsync(10000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    f.state(true, true); await vi.advanceTimersByTimeAsync(5000);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledWith("editor:save");
  });

  it("interval ticks despite continuous edits and only while dirty", async () => {
    const f = fixture({ mode: "interval", intervalSeconds: 5 }); await createAutosaveTimer(f.ctx).ready;
    await f.start();
    for (let i = 0; i < 10; i++) { f.state(); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(2);
    f.state(false); await vi.advanceTimersByTimeAsync(15000);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(["pause", "interval"])("%s retries refusal after its delay, without a new fact", async mode => {
    const f = fixture({ mode, intervalSeconds: 5 }); await createAutosaveTimer(f.ctx).ready;
    f.ctx.actions.dispatch.mockReturnValueOnce(false).mockReturnValue(true);
    await f.start(); f.state();
    const delay = mode === "pause" ? 2000 : 5000;
    await vi.advanceTimersByTimeAsync(delay);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(2);
    f.state(false); await vi.advanceTimersByTimeAsync(delay * 3);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(["pause", "interval"])("%s clears all timers on inactive state and on generation disposal", async mode => {
    const f = fixture({ mode, intervalSeconds: 5 }); await createAutosaveTimer(f.ctx).ready;
    await f.start(); f.state(); f.end();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    await f.start(); f.state(); f.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
  });

  it("rereads settings on every editing transition; a read failure turns it off until the next read", async () => {
    const f = fixture(); await createAutosaveTimer(f.ctx).ready;
    f.ctx.settings.read.mockRejectedValueOnce(Error("offline"));
    await f.start(); f.state(); await vi.advanceTimersByTimeAsync(10000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    f.end(); await f.start(); f.state(); await vi.advanceTimersByTimeAsync(2000);
    expect(f.ctx.settings.read).toHaveBeenCalledTimes(3);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
    f.ctx.settings.read.mockResolvedValueOnce({ values: { enabled: false } });
    f.end(); await f.start(); f.state(); await vi.advanceTimersByTimeAsync(10000);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
  });

  it("activation read failure and missing enabled default to off", async () => {
    const f = fixture(); f.ctx.settings.read.mockRejectedValueOnce(Error("offline")).mockResolvedValue({ values: {} });
    await createAutosaveTimer(f.ctx).ready; await f.start(); f.state();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [{ pauseSeconds: -5 }, 1000], [{ pauseSeconds: 100 }, 60000],
    [{ pauseSeconds: 1.7 }, 2000], [{ pauseSeconds: "1" }, 2000],
    [{ pauseSeconds: NaN }, 2000], [{ mode: "unknown" }, 2000],
    [{ mode: "interval", intervalSeconds: 1 }, 5000],
    [{ mode: "interval", intervalSeconds: 99999 }, 3600000],
    [{ mode: "interval", intervalSeconds: Infinity }, 30000],
  ])("validates defaults and bounds for %j", async (settings, delay) => {
    const f = fixture(settings); await createAutosaveTimer(f.ctx).ready;
    await f.start(); f.state(); await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
  });

  it("fences late reads across activation, replacement sessions and disposal", async () => {
    const f = fixture(); const reads = [];
    f.ctx.settings.read.mockImplementation(() => new Promise(resolve => reads.push(resolve)));
    const scheduler = createAutosaveTimer(f.ctx);
    await f.start(); f.state();
    reads[1]({ values: { enabled: false } }); await Promise.resolve();
    reads[0]({ values: { enabled: true } }); await scheduler.ready;
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    f.end(); await f.start(); f.state(); f.end();
    reads[2]({ values: { enabled: true, mode: "interval" } }); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    await f.start(); f.state(); scheduler.dispose();
    reads[3]({ values: { enabled: true } }); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pause", "interval"])("%s activation replays an existing dirty edit session and saves without a new start event", async mode => {
    const f = fixture({ mode, intervalSeconds: 5 }, { editing: true, unsaved: true, canSave: true });
    await createAutosaveTimer(f.ctx).ready;
    await vi.advanceTimersByTimeAsync(mode === "pause" ? 2000 : 5000);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledExactlyOnceWith("editor:save");
    expect(f.ctx.settings.read).toHaveBeenCalledTimes(2);
    f.end();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores edge events and retains current settings until the next editing transition", async () => {
    const f = fixture(); await createAutosaveTimer(f.ctx).ready;
    f.emit("edit-start"); f.state(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.ctx.actions.dispatch).not.toHaveBeenCalled();
    await f.start(); f.state();
    f.ctx.settings.read.mockResolvedValue({ values: { enabled: false } });
    f.emit("edit-end"); f.state(); await vi.advanceTimersByTimeAsync(2000);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
    f.end(); await f.start(); f.state(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.ctx.actions.dispatch).toHaveBeenCalledTimes(1);
  });
});
