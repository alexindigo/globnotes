import { describe, it, expect, vi } from "vitest";
import { subscribe, publish, TOPICS } from "../bus/index.js";

describe("event bus", () => {
  it("delivers published payload to subscriber", () => {
    const handler = vi.fn();
    subscribe(TOPICS.NOTE_OPEN, handler);
    publish(TOPICS.NOTE_OPEN, { title: "foo" });
    expect(handler).toHaveBeenCalledWith({ title: "foo" });
  });

  it("returns an unsubscribe function", () => {
    const handler = vi.fn();
    const unsub = subscribe(TOPICS.NOTE_SAVE, handler);
    publish(TOPICS.NOTE_SAVE, { title: "foo" });
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    publish(TOPICS.NOTE_SAVE, { title: "bar" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not deliver to unsubscribed handlers", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    subscribe(TOPICS.NOTE_DELETE, h1);
    subscribe(TOPICS.NOTE_DELETE, h2);
    publish(TOPICS.NOTE_DELETE, { title: "x" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    publish(TOPICS.NOTE_DELETE, { title: "y" });
    expect(h1).toHaveBeenCalledTimes(2);
    expect(h2).toHaveBeenCalledTimes(2);
  });

  it("does not leak between topics", () => {
    const handler = vi.fn();
    subscribe(TOPICS.NOTE_CREATE, handler);
    publish(TOPICS.NOTE_RENAME, { oldTitle: "a", newTitle: "b" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows multiple subscribers on the same topic", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    subscribe(TOPICS.NOTE_OPEN, h1);
    subscribe(TOPICS.NOTE_OPEN, h2);
    publish(TOPICS.NOTE_OPEN, { title: "x" });
    expect(h1).toHaveBeenCalledWith({ title: "x" });
    expect(h2).toHaveBeenCalledWith({ title: "x" });
  });
});
