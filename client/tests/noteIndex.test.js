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
      .mockResolvedValueOnce(["a/b", "c"]);
    const store = useGlobalStore();
    const p = refreshNoteIndex();
    await vi.runAllTimersAsync();
    await p;
    expect(getNoteIndex).toHaveBeenCalledTimes(3);
    expect(store.noteTitles).toEqual(["a/b", "c"]);
  });

  it("gives up after retries and leaves the list empty", async () => {
    getNoteIndex.mockRejectedValue(new Error("boom"));
    const store = useGlobalStore();
    const p = refreshNoteIndex();
    await vi.runAllTimersAsync();
    await p;
    // initial attempt + 3 retries
    expect(getNoteIndex).toHaveBeenCalledTimes(4);
    expect(store.noteTitles).toEqual([]);
  });

  it("keeps previously loaded titles when all retries fail", async () => {
    getNoteIndex.mockRejectedValue(new Error("boom"));
    const store = useGlobalStore();
    store.noteTitles = ["existing/note"];
    const p = refreshNoteIndex();
    await vi.runAllTimersAsync();
    await p;
    expect(store.noteTitles).toEqual(["existing/note"]);
  });
});
