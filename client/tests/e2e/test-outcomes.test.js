import { describe, expect, it } from "vitest";
import { childSucceeded, copiedText, renamedConsumer, tokenColors } from "./test-outcomes.mjs";

describe("native outcomes reject false greens", () => {
  it("rejects a visible copy button whose clipboard consumer has the wrong bytes", () => {
    expect(() => copiedText("old clipboard", "selected block\n")).toThrow("Clipboard bytes");
    expect(() => copiedText("selected block\n", "selected block\n")).not.toThrow();
  });
  it("rejects a missing third token despite two successful different samples", () => {
    expect(() => tokenColors([
      { theme: "a", actual: "red", expected: "red" },
      { theme: "b", actual: "blue", expected: "blue" },
      { theme: "c", actual: null, expected: "green" },
    ])).toThrow("c:");
  });
  it("rejects a wrong immediate rename consumer even when persistence after reload is correct", () => {
    expect(() => renamedConsumer({ href: "old.png", loaded: true }, { href: "new.png", loaded: true })).toThrow("href");
  });
  it("a printed success marker cannot override a failed or timed-out child", () => {
    expect(() => childSucceeded({ success: false, code: 1, stdout: "ALL PAGES OK" }, "fixture")).toThrow("exit 1");
    expect(() => childSucceeded({ success: false, code: 124, stdout: "CHAIN COMPLETE" }, "fixture")).toThrow("exit 124");
    expect(() => childSucceeded({ success: true, code: 0 }, "fixture")).not.toThrow();
  });
});
