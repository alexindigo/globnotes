import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return await import("../searchPreferences.js");
}

describe("search preferences", () => {
  beforeEach(() => localStorage.clear());

  it.each([null, "true", "false", "FALSE", "", "0"])(
    "excludes nested folders only for the exact stored false string: %s",
    async stored => {
      if (stored !== null) localStorage.setItem("includeNested", stored);
      const store = await freshStore();
      expect(store.includeNested.value).toBe(stored !== "false");
      expect(localStorage.getItem("includeNested")).toBe(stored);
    },
  );

  it("persists and delivers both toggle values before a fresh consumer restores them", async () => {
    const store = await freshStore();
    const { subscribe, TOPICS } = await import("../bus/index.js");
    const events = [];
    const unsubscribe = subscribe(TOPICS.SEARCH_INCLUDE_NESTED, event => events.push({
      event, current: store.includeNested.value, stored: localStorage.getItem("includeNested"),
    }));
    store.setIncludeNested(false);
    expect(store.includeNested.value).toBe(false);
    expect(localStorage.getItem("includeNested")).toBe("false");
    store.setIncludeNested(true);
    unsubscribe();
    expect(events).toEqual([
      { event: { value: false }, current: false, stored: "false" },
      { event: { value: true }, current: true, stored: "true" },
    ]);
    const restored = await freshStore();
    expect(restored.includeNested.value).toBe(true);
    expect(localStorage.length).toBe(1);
  });
});
