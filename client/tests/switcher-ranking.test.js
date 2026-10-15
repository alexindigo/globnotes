import { describe, expect, it } from "vitest";
import { rankSwitcherResults, switcherAnnotation, switcherMatchKind } from "../switcherRanking.js";

const note = (path, title, aliases = []) => ({ path, title, aliases });

describe("switcher ranking", () => {
  it("weights title above alias above basename above path", () => {
    const meta = [note("hit/path", "Other"), note("N/hit", "Other"), note("N/A", "Other", ["hit"]), note("N/T", "hit")];
    const results = rankSwitcherResults("hit", meta, []);
    expect(results.map(entry => entry.item.path)).toEqual(["N/T", "N/A", "N/hit", "hit/path"]);
    expect(results.map(entry => entry.matchedKind)).toEqual(["title", "alias", "file", "path"]);
  });

  it("keeps cross-segment path queries and notes without aliases findable", () => {
    const item = { path: "recipes/soup", title: "Lunch" };
    const [entry] = rankSwitcherResults("recipes/soup", [item], []);
    expect(entry.item).toBe(item);
    expect(entry.matchedKind).toBe("path");
    expect(switcherAnnotation(entry).text).toBe("recipes/soup");
  });

  it("trims and strips one leading hash for matching", () => {
    const meta = [note("N/Lunch", "Apple soup")];
    expect(rankSwitcherResults("  #apple  ", meta, [])).toEqual(rankSwitcherResults("apple", meta, []));
    expect(rankSwitcherResults("##apple", meta, [])).toEqual([]);
  });

  it("uses metadata order for a lone hash rather than recent order", () => {
    const meta = [note("A", "A"), note("B", "B")];
    expect(rankSwitcherResults("#", meta, ["B"]).map(entry => entry.item.path)).toEqual(["A", "B"]);
  });

  it("uses recent order, current metadata and basename fallback on empty input", () => {
    const item = note("N/A", "Display A", ["alias"]);
    const results = rankSwitcherResults(" \t ", [item, note("N/B", "B")], ["missing/Old", "N/A"]);
    expect(results).toEqual([
      { item: note("missing/Old", "Old"), score: 0, positions: [], matchedText: null, matchedKind: null },
      { item, score: 0, positions: [], matchedText: null, matchedKind: null },
    ]);
    expect(switcherMatchKind(results[0])).toBeNull();
  });

  it.each(["a", ""])('caps note rows at nine for query "%s" without mutating sources', query => {
    const meta = Array.from({ length: 12 }, (_, i) => note(`N/a${i}`, `a${i}`));
    const recent = meta.map(item => item.path).reverse();
    const before = structuredClone({ meta, recent });
    expect(rankSwitcherResults(query, meta, recent)).toHaveLength(9);
    expect({ meta, recent }).toEqual(before);
  });

  it("preserves metadata order for tied scores and returns no unmatched rows", () => {
    const meta = [note("N/B", "Same"), note("N/A", "Same")];
    expect(rankSwitcherResults("same", meta, []).map(entry => entry.item.path)).toEqual(["N/B", "N/A"]);
    expect(rankSwitcherResults("zzz", meta, [])).toEqual([]);
  });
});

describe("switcher annotations", () => {
  it.each([
    [note("N/A", "Soup"), "soup", "title", "Soup", [0, 1, 2, 3]],
    [note("N/A", "Lunch", ["soup"]), "soup", "alias", "soup", [0, 1, 2, 3]],
    [note("N/soup", "Lunch"), "soup", "file", "N/soup", [2, 3, 4, 5]],
    [note("N/soup", "soup"), "soup", "file", "N/soup", [2, 3, 4, 5]],
    [note("soup/A", "Lunch"), "soup/", "path", "soup/A", [0, 1, 2, 3, 4]],
  ])("annotates %j for %s as %s", (item, query, kind, text, positions) => {
    const [entry] = rankSwitcherResults(query, [item], []);
    expect(switcherMatchKind(entry)).toBe(kind);
    expect(switcherAnnotation(entry)).toEqual({ text, positions, elidedStart: false });
  });

  it("windows a deep file match and rebases positions into its retained path context", () => {
    const item = note("very/long/".repeat(12) + "soup", "Lunch");
    const [entry] = rankSwitcherResults("soup", [item], []);
    const annotation = switcherAnnotation(entry);
    expect(annotation.elidedStart).toBe(true);
    expect(annotation.text.startsWith("…")).toBe(true);
    expect(annotation.text.endsWith("soup")).toBe(true);
    expect(annotation.positions.map(position => annotation.text[position]).join("")).toBe("soup");
  });
});
