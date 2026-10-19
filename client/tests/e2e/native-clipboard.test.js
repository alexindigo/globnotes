import { describe, expect, it, vi } from "vitest";
import { clipboardRestored, restoreClipboard } from "./native-clipboard.mjs";

const text = data => ({ type: "text/plain", data });

describe("clipboard restoration", () => {
  it.each([
    ["empty snapshot and no offers", [], [], true],
    ["empty snapshot and an empty text offer", [], [text("")], true],
    ["empty snapshot and real data", [], [text("x")], false],
    ["non-empty exact snapshot", [text("kept")], [text("kept")], true],
    ["non-empty mismatched snapshot", [text("kept")], [text("changed")], false],
  ])("%s", (_name, snapshot, captured, expected) => {
    expect(clipboardRestored(snapshot, captured)).toBe(expected);
  });
  it("replaces old clipboard data with an explicit empty text offer", async () => {
    const page = {};
    let offered = [text("old clipboard data")];
    const write = vi.fn(async (_page, items) => { if (items.length) offered = items; });
    const capture = vi.fn(async () => offered);
    await expect(restoreClipboard(page, [], { write, capture })).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledExactlyOnceWith(page, [text("")]);
    expect(offered.every(item => item.data === "")).toBe(true);
    expect(capture).toHaveBeenCalledExactlyOnceWith(page);
  });
  it("writes the unchanged non-empty snapshot", async () => {
    const page = {}, snapshot = [text("keep these bytes")];
    const write = vi.fn(async () => {}), capture = vi.fn(async () => snapshot);
    await restoreClipboard(page, snapshot, { write, capture });
    expect(write).toHaveBeenCalledExactlyOnceWith(page, snapshot);
  });
});
