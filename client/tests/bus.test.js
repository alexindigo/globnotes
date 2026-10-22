import { describe, it, expect, vi } from "vitest";
import { subscribe, publish, TOPICS } from "../bus/index.js";

describe("event bus", () => {
  it("delivers published payload to subscriber", () => {
    const handler = vi.fn();
    subscribe(TOPICS.NOTE_OPEN, handler);
    publish(TOPICS.NOTE_OPEN, { path: "foo" });
    expect(handler).toHaveBeenCalledWith({ path: "foo" });
  });

  it("returns an unsubscribe function", () => {
    const handler = vi.fn();
    const unsub = subscribe(TOPICS.NOTE_SAVE, handler);
    publish(TOPICS.NOTE_SAVE, { path: "foo" });
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    publish(TOPICS.NOTE_SAVE, { path: "bar" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not leak between topics", () => {
    const handler = vi.fn();
    subscribe(TOPICS.NOTE_CREATE, handler);
    publish(TOPICS.NOTE_RENAME, { oldPath: "a", newPath: "b" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows multiple subscribers on the same topic", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    subscribe(TOPICS.NOTE_OPEN, h1);
    subscribe(TOPICS.NOTE_OPEN, h2);
    publish(TOPICS.NOTE_OPEN, { path: "x" });
    expect(h1).toHaveBeenCalledWith({ path: "x" });
    expect(h2).toHaveBeenCalledWith({ path: "x" });
  });

  it("replays retained state once on a microtask, then delivers live changes", async () => {
    const state = { path: "Late", revision: 1, editing: true, unsaved: true, canSave: true };
    publish(TOPICS.NOTE_EDIT_STATE, state);
    const handler = vi.fn(), release = subscribe(TOPICS.NOTE_EDIT_STATE, handler);
    expect(handler).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledExactlyOnceWith(state);
    const ended = { ...state, editing: false, unsaved: false, canSave: false };
    publish(TOPICS.NOTE_EDIT_STATE, ended);
    expect(handler).toHaveBeenLastCalledWith(ended);
    release();
    publish(TOPICS.NOTE_EDIT_STATE, state);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("never replays event topics", async () => {
    publish(TOPICS.NOTE_EDIT_START, { path: "Past" });
    const handler = vi.fn(), release = subscribe(TOPICS.NOTE_EDIT_START, handler);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    release();
  });

  it("cancels queued retained delivery when unsubscribed", async () => {
    publish(TOPICS.NOTE_EDIT_STATE, { editing: true });
    const handler = vi.fn(), release = subscribe(TOPICS.NOTE_EDIT_STATE, handler);
    release(); await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps live retained delivery current under synchronous reentrant publication", async () => {
    const observed = [];
    const a = subscribe(TOPICS.NOTE_EDIT_STATE, state => {
      if (!state.editing) publish(TOPICS.NOTE_EDIT_STATE, { editing: true });
    });
    const b = subscribe(TOPICS.NOTE_EDIT_STATE, state => observed.push(state));
    const late = vi.fn();
    let release = () => {};
    try {
      publish(TOPICS.NOTE_EDIT_STATE, { editing: false });
      release = subscribe(TOPICS.NOTE_EDIT_STATE, late);
      await Promise.resolve();
      expect(observed.at(-1)).toEqual({ editing: true });
      expect(late).toHaveBeenLastCalledWith(observed.at(-1));
    } finally { a(); b(); release(); }
  });

  it("does not replay stale state after a newer live publication", async () => {
    publish(TOPICS.NOTE_EDIT_STATE, { editing: true });
    const handler = vi.fn(), release = subscribe(TOPICS.NOTE_EDIT_STATE, handler);
    publish(TOPICS.NOTE_EDIT_STATE, { editing: false });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledExactlyOnceWith({ editing: false });
    release();
  });
});
