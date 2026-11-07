import { describe, expect, it } from "vitest";
import { conflictFileHref, conflictTarget, conflictsTarget, reviewConflictTarget, sameConflictPair } from "../conflictNavigation.js";
describe("conflict route targets", () => {
  it("uses id identity and matches only the current copy", () => {
    expect(conflictsTarget()).toEqual({ name: "conflicts" });
    expect(conflictTarget("id/#")).toEqual({ name: "conflict", params: { id: "id/#" } });
    const inbox = { lookupByMember: (path, member) => path === "Copy.md" && member === "copyPath" ? { id: "c" } : null };
    expect(reviewConflictTarget(inbox, "Copy")).toEqual(conflictTarget("c"));
    expect(reviewConflictTarget(inbox, "Original")).toEqual(conflictsTarget());
  });
  it("keeps deployment prefixes and escapes file path segments", () => {
    expect(conflictFileHref("folder/a #%.bin", "/notes")).toBe("/notes/_/api/files/folder/a%20%23%25.bin");
  });
  it("compares both byte versions, member paths and record revision", () => {
    const a = { id: "c", state: "open", revision: 1, original: { path: "A", version: "v1" }, copy: { path: "B", version: "v2" } };
    expect(sameConflictPair(a, structuredClone(a))).toBe(true);
    for (const b of [{ ...a, revision: 2 }, { ...a, original: { ...a.original, version: "v3" } }, { ...a, copy: { ...a.copy, path: "C" } }, { ...a, state: "resolved" }]) expect(sameConflictPair(a, b)).toBe(false);
  });
});
