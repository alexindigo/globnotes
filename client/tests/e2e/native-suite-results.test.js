import { describe, expect, it, vi } from "vitest";
import { runChildren, SELECTION } from "./legacy-native-suite.mjs";

describe("native suite child result ownership", () => {
  it("rejects a nonzero child even when output contains the old pass marker and never starts later cases", async () => {
    const execute = vi.fn(async () => ({ success: false, code: 1, stdout: "distinct body backgrounds: 2; COPY BUTTON OK" }));
    await expect(runChildren([["broken"], ["later"]], execute)).rejects.toThrow("exit 1");
    expect(execute.mock.calls).toEqual([["broken", [], { timeout: 120000 }]]);
  });
  it("does not require magic output from a genuinely successful child", async () => {
    await expect(runChildren([["a", "move"], ["b"]], async () => ({ success: true, code: 0, stdout: "" }))).resolves.toEqual([
      { name: "a", args: ["move"], code: 0 }, { name: "b", args: [], code: 0 },
    ]);
  });
  it("gives the real-time autosave scenarios their own budget and retains the default for every other child", async () => {
    const execute = vi.fn(async () => ({ success: true, code: 0 }));
    await runChildren(SELECTION, execute);
    expect(execute.mock.calls).toEqual(SELECTION.map(([name, ...args]) => [
      name, args, { timeout: name === "autosave-timer" ? 300000 : 120000 },
    ]));
  });
  it("rejects a timed-out child even if it exits zero and never starts later cases", async () => {
    const execute = vi.fn(async () => ({ success: true, code: 0, timedOut: true }));
    await expect(runChildren([["autosave-timer"], ["later"]], execute)).rejects.toThrow("autosave-timer: child timed out");
    expect(execute.mock.calls).toEqual([["autosave-timer", [], { timeout: 300000 }]]);
  });
});
