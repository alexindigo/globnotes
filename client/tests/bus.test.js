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

  it("does not deliver to unsubscribed handlers", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    subscribe(TOPICS.NOTE_DELETE, h1);
    subscribe(TOPICS.NOTE_DELETE, h2);
    publish(TOPICS.NOTE_DELETE, { path: "x" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    publish(TOPICS.NOTE_DELETE, { path: "y" });
    expect(h1).toHaveBeenCalledTimes(2);
    expect(h2).toHaveBeenCalledTimes(2);
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
});
