import { describe, expect, it, vi } from "vitest";
import { concurrencyValue, FILE_CASES, runChildren, SELECTION, selectCases, SERIAL_CASES } from "./legacy-native-suite.mjs";

describe("native suite child result ownership", () => {
  it("includes sync status in CI, filtered runs and source-owned case selection", () => {
    expect(selectCases()).toContainEqual(["sync-status-native"]);
    expect(selectCases("sync-status-native")).toEqual([
      ["native-ownership-control"], ["native-actions-control"], ["sync-status-native"],
    ]);
    expect(FILE_CASES["client/tests/e2e/sync-status-native.mjs"]).toEqual(["sync-status-native"]);
  });
  it("rejects a nonzero child even when output contains the old pass marker and never starts later cases", async () => {
    const execute = vi.fn(async () => ({ success: false, code: 1, stdout: "distinct body backgrounds: 2; COPY BUTTON OK" }));
    await expect(runChildren([["broken"], ["later"]], execute, { concurrency: 1 })).rejects.toThrow("exit 1");
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
    await expect(runChildren([["autosave-timer"], ["later"]], execute, { concurrency: 1 })).rejects.toThrow("autosave-timer: child timed out");
    expect(execute.mock.calls).toEqual([["autosave-timer", [], { timeout: 300000 }]]);
  });
  it("defaults to three active children, preserves order and drains before exclusive cases", async () => {
    const running = new Map(), starts = [];
    let active = 0, peak = 0;
    const execute = vi.fn(name => {
      starts.push(name); active++; peak = Math.max(peak, active);
      if (SERIAL_CASES[name]) expect(active).toBe(1);
      return new Promise(resolve => running.set(name, () => {
        active--; resolve({ success: true, code: 0 });
      }));
    });
    const selection = [["a"], ["b"], ["c"], ["d"], ["copy-button"], ["e"]];
    const result = runChildren(selection, execute);
    expect(starts).toEqual(["a", "b", "c"]);
    running.get("b")(); await vi.waitFor(() => expect(starts).toContain("d"));
    running.get("d")(); running.get("c")();
    await Promise.resolve(); expect(starts).not.toContain("copy-button");
    running.get("a")(); await vi.waitFor(() => expect(starts).toContain("copy-button"));
    expect(starts).not.toContain("e");
    running.get("copy-button")(); await vi.waitFor(() => expect(starts).toContain("e"));
    running.get("e")();
    expect((await result).map(row => row.name)).toEqual(selection.map(([name]) => name));
    expect(peak).toBe(3);
  });
  it("stops admission on failure but waits for admitted children", async () => {
    let finish;
    const execute = vi.fn(name => name === "bad" ? Promise.resolve({ success: false, code: 7 }) : new Promise(resolve => { finish = resolve; }));
    const result = runChildren([["bad"], ["in-flight"], ["later"]], execute, { concurrency: 2 });
    const rejected = expect(result).rejects.toThrow("exit 7");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    finish({ success: true, code: 0 }); await rejected;
    expect(execute.mock.calls.map(([name]) => name)).toEqual(["bad", "in-flight"]);
  });
  it("validates configuration before starting any child", async () => {
    expect(concurrencyValue()).toBe(3);
    expect(concurrencyValue("1")).toBe(1);
    for (const value of ["0", "-1", "1.5", "no", "", Infinity]) {
      const execute = vi.fn();
      await expect(runChildren([["a"]], execute, { concurrency: value })).rejects.toThrow("positive integer");
      expect(execute).not.toHaveBeenCalled();
    }
  });
});
