// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  getNoteIndex: vi.fn(),
}));

import { createPinia, setActivePinia } from "pinia";
import { getNoteIndex } from "../api.js";
import { useGlobalStore } from "../globalStore.js";
import { refreshNoteIndex } from "../noteIndex.js";

describe("refreshNoteIndex", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    getNoteIndex.mockReset();
  });

  it("retries on failure and populates the store on success", async () => {
    getNoteIndex
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([
        { path: "a/b", title: "b", aliases: [] },
        { path: "c", title: "c", aliases: [] },
      ]);
    const store = useGlobalStore();
    const p = refreshNoteIndex();
    await vi.runAllTimersAsync();
    await p;
    expect(getNoteIndex).toHaveBeenCalledTimes(3);
    expect(store.notePaths).toEqual(["a/b", "c"]);
    expect(store.noteMeta).toHaveLength(2);
  });

  it("gives up after retries and leaves the list empty", async () => {
    getNoteIndex.mockRejectedValue(new Error("boom"));
    const store = useGlobalStore();
    const p = refreshNoteIndex();
    await vi.runAllTimersAsync();
    await p;
    // initial attempt + 3 retries
    expect(getNoteIndex).toHaveBeenCalledTimes(4);
    expect(store.notePaths).toEqual([]);
  });

  it("keeps previously loaded titles when all retries fail", async () => {
    getNoteIndex.mockRejectedValue(new Error("boom"));
    const store = useGlobalStore();
    store.notePaths = ["existing/note"];
    const p = refreshNoteIndex();
    await vi.runAllTimersAsync();
    await p;
    expect(store.notePaths).toEqual(["existing/note"]);
  });
});
