import { describe, expect, it } from "vitest";
import { createConflictDraftStore } from "../conflictDrafts.js";
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key), map }; };
const record = content => ({ content, revision: 3, base: { original: { kind: "version", version: "o" }, copy: { kind: "version", version: "c" } } });
describe("conflict browser drafts", () => {
  it("separates deployment/vault/id, preserves exact text and remembered-token storage", () => {
    const local = storage(), session = storage(); let remembered = true;
    const drafts = createConflictDraftStore({ local, session, isTokenStored: () => remembered });
    drafts.save("/prefix:globnotes", "a", record("\uFEFF# literal\r\n"), 1);
    remembered = false; drafts.save("/prefix:globnotes", "b", record("session"), 2);
    expect(drafts.load("/other:globnotes", "a")).toBeNull(); expect(drafts.load("/prefix:other", "a")).toBeNull();
    expect(drafts.load("/prefix:globnotes", "a")).toEqual(record("\uFEFF# literal\r\n"));
    expect(local.map.size).toBe(1); expect(session.map.size).toBe(1);
    expect([...local.map.keys()][0]).toMatch(/^globnotes:conflict-draft:/);
  });
  it("acknowledges only captured revisions and never clears a replacement owner's value", () => {
    const local = storage(), session = storage(), options = { local, session, isTokenStored: () => true };
    const a = createConflictDraftStore(options), b = createConflictDraftStore(options);
    a.save("scope", "a", record("old"), 1); a.save("scope", "b", record("new"), 2);
    a.clearAcknowledged(1); expect(a.load("scope", "a")).toBeNull(); expect(a.load("scope", "b").content).toBe("new");
    b.save("scope", "b", record("replacement"), 3); a.clear(); expect(b.load("scope", "b").content).toBe("replacement");
    b.release(); b.clear(); expect(b.load("scope", "b").content).toBe("replacement");
  });
});
