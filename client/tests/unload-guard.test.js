import { afterEach, describe, expect, it } from "vitest";
import { createUnloadConfirmation, setBeforeUnloadConfirmation } from "../unloadGuard.js";

describe("browser unload confirmation", () => {
  afterEach(() => setBeforeUnloadConfirmation(false));

  it("late retirement cannot clear a replacement workflow's warning", () => {
    const target = {}, first = createUnloadConfirmation(target), second = createUnloadConfirmation(target);
    first.set(true); second.set(true); first.dispose(); expect(target.onbeforeunload()).toBe(true);
    first.set(false); expect(target.onbeforeunload()).toBe(true); second.dispose(); expect(target.onbeforeunload).toBeNull();
  });

  it("enables the existing true-returning confirmation by default", () => {
    setBeforeUnloadConfirmation();
    expect(window.onbeforeunload).toBeTypeOf("function");
    expect(window.onbeforeunload()).toBe(true);
  });

  it("clears confirmation when the caller becomes clean", () => {
    setBeforeUnloadConfirmation(true);
    setBeforeUnloadConfirmation(false);
    expect(window.onbeforeunload).toBeNull();
  });

  it("accepts a platform adapter and preserves repeated enable/disable behavior", () => {
    const target = { onbeforeunload: null };
    setBeforeUnloadConfirmation(true, target);
    const first = target.onbeforeunload;
    setBeforeUnloadConfirmation(true, target);
    expect(target.onbeforeunload).not.toBe(first);
    expect(target.onbeforeunload()).toBe(true);
    setBeforeUnloadConfirmation(false, target);
    setBeforeUnloadConfirmation(false, target);
    expect(target.onbeforeunload).toBeNull();
  });
});
