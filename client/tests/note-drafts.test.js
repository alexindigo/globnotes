import { beforeEach, describe, expect, it } from "vitest";
import { createNoteDraftStore } from "../noteDrafts.js";
import { storeToken } from "../tokenStorage.js";

describe("note draft ownership", () => {
  let drafts;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    drafts = createNoteDraftStore();
  });

  it("uses session storage without a remembered current token", () => {
    drafts.save("folder/Note", "work", 1);
    expect(sessionStorage.getItem("folder/Note")).toBe("work");
    expect(localStorage.getItem("folder/Note")).toBeNull();
  });

  it("uses local storage when the current token is remembered", () => {
    storeToken("remembered", true);
    drafts.save("Note", "work", 1);
    expect(localStorage.getItem("Note")).toBe("work");
    expect(sessionStorage.getItem("Note")).toBeNull();
  });

  it("checks the current token at each save, including changed sessions", () => {
    storeToken("remembered", true);
    drafts.save("Note", "remembered work", 1);
    storeToken("different", false);
    drafts.save("Note", "session work", 2);
    expect(localStorage.getItem("Note")).toBe("remembered work");
    expect(sessionStorage.getItem("Note")).toBe("session work");
  });

  it("accepts adapter overrides without Vue or browser storage", () => {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    };
    const store = createNoteDraftStore({ local: storage, session: storage, isTokenStored: () => true });
    store.save("Note", "injected work", 1);
    expect(store.load("Note", 1)).toBe("injected work");
    store.clear();
    expect(values.size).toBe(0);
  });

  it("loads local before session and owns both copies", () => {
    localStorage.setItem("Note", "local work");
    sessionStorage.setItem("Note", "session work");
    expect(drafts.load("Note", 1)).toBe("local work");
    drafts.clear();
    expect(localStorage.getItem("Note")).toBeNull();
    expect(sessionStorage.getItem("Note")).toBeNull();
  });

  it("loads session storage when local is absent", () => {
    sessionStorage.setItem("Note", "session work");
    expect(drafts.load("Note", 1)).toBe("session work");
    expect(drafts.load("Missing", 1)).toBeNull();
  });

  it("retains an empty local draft ahead of a nonempty session draft", () => {
    localStorage.setItem("Note", "");
    sessionStorage.setItem("Note", "session work");
    expect(drafts.load("Note", 1)).toBe("");
  });

  it("persists empty content but ignores absent paths and non-string content", () => {
    drafts.save("Note", "", 1);
    drafts.save("", "ignored", 1);
    drafts.save(null, "ignored", 1);
    drafts.save("Other", undefined, 1);
    expect(drafts.load("Note", 1)).toBe("");
    expect(drafts.load("", 1)).toBeNull();
    expect(sessionStorage.length).toBe(1);
  });

  it("clears all owned rename aliases but preserves unrelated drafts", () => {
    sessionStorage.setItem("Unrelated", "other work");
    drafts.save("Old", "old work", 1);
    drafts.save("New", "new work", 2);
    drafts.clear();
    expect(sessionStorage.getItem("Old")).toBeNull();
    expect(sessionStorage.getItem("New")).toBeNull();
    expect(sessionStorage.getItem("Unrelated")).toBe("other work");
  });

  it("explicit clear cannot delete another owner's newer bytes", () => {
    drafts.save("Note", "owned work", 1);
    sessionStorage.setItem("Note", "other work");
    drafts.clear();
    expect(sessionStorage.getItem("Note")).toBe("other work");
    sessionStorage.setItem("Note", "owned work");
    drafts.clear();
    expect(sessionStorage.getItem("Note")).toBe("owned work");
  });

  it("acknowledgement clears only revisions at or below its captured revision", () => {
    drafts.save("Old", "old work", 1);
    drafts.save("New", "new work", 2);
    drafts.clearAcknowledged(1);
    expect(sessionStorage.getItem("Old")).toBeNull();
    expect(sessionStorage.getItem("New")).toBe("new work");
    drafts.clearAcknowledged(2);
    expect(sessionStorage.getItem("New")).toBeNull();
  });

  it("acknowledgement checks stored bytes as well as revisions", () => {
    drafts.save("Note", "owned work", 1);
    sessionStorage.setItem("Note", "other work");
    drafts.clearAcknowledged(1);
    expect(sessionStorage.getItem("Note")).toBe("other work");
  });

  it("a later save replaces the owned revision for the same storage and path", () => {
    drafts.save("Note", "first", 1);
    drafts.save("Note", "second", 2);
    drafts.clearAcknowledged(1);
    expect(sessionStorage.getItem("Note")).toBe("second");
  });

  it("release preserves bytes and prevents subsequent clear from erasing them", () => {
    drafts.save("Note", "work", 1);
    drafts.release();
    drafts.clearAcknowledged(1);
    drafts.clear();
    expect(sessionStorage.getItem("Note")).toBe("work");
    expect(drafts.load("Note", 2)).toBe("work");
    drafts.clearAcknowledged(2);
    expect(sessionStorage.getItem("Note")).toBeNull();
  });

  it("separate note owners cannot clear drafts they never saved or loaded", () => {
    drafts.save("Note", "work", 1);
    createNoteDraftStore().clear();
    expect(sessionStorage.getItem("Note")).toBe("work");
  });
});
