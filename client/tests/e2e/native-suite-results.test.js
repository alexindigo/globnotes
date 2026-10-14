import { describe, expect, it, vi } from "vitest";
import { runChildren } from "./legacy-native-suite.mjs";

describe("native suite child result ownership", () => {
  it("rejects a nonzero child even when output contains the old pass marker and never starts later cases", async () => {
    const execute = vi.fn(async () => ({ success: false, code: 1, stdout: "distinct body backgrounds: 2; COPY BUTTON OK" }));
    await expect(runChildren([["broken"], ["later"]], execute)).rejects.toThrow("exit 1");
    expect(execute.mock.calls).toEqual([["broken", []]]);
  });
  it("does not require magic output from a genuinely successful child", async () => {
    await expect(runChildren([["a", "move"], ["b"]], async () => ({ success: true, code: 0, stdout: "" }))).resolves.toEqual([
      { name: "a", args: ["move"], code: 0 }, { name: "b", args: [], code: 0 },
    ]);
  });
});
