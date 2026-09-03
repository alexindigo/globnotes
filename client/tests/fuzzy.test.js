import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../fuzzy.js";

describe("fuzzyScore", () => {
  it("returns null when query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
  });

  it("matches a subsequence case-insensitively", () => {
    expect(fuzzyScore("soup", "Dad Recipes Soup")).not.toBeNull();
    expect(fuzzyScore("DS", "DadSoup")).not.toBeNull();
  });

  it("scores word-start matches higher", () => {
    const wordStart = fuzzyScore("soup", "soup recipe").score;
    const mid = fuzzyScore("soup", "tastyxsoup").score;
    expect(wordStart).toBeGreaterThan(mid);
  });

  it("prefers shorter targets", () => {
    const short = fuzzyScore("soup", "soup").score;
    const long = fuzzyScore("soup", "soup with many extra words here").score;
    expect(short).toBeGreaterThan(long);
  });

  it("returns empty positions for empty query", () => {
    expect(fuzzyScore("", "anything")).toEqual({ score: 0, positions: [] });
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { path: "folders/dad/recipes/soup", title: "Soup", aliases: ["broth"] },
    { path: "ideas", title: "Ideas", aliases: [] },
  ];
  // Mirrors SwitcherPanel's matchText: title, aliases, full vault path
  // (folder-name matching parity with the full search page).
  const matchText = (n) => [n.title, ...(n.aliases || []), n.path];

  it("matches on title, alias, or basename", () => {
    expect(fuzzyFilter("soup", items, matchText).map((r) => r.item.path)).toEqual([
      "folders/dad/recipes/soup",
    ]);
    expect(fuzzyFilter("broth", items, matchText).map((r) => r.item.path)).toEqual([
      "folders/dad/recipes/soup",
    ]);
    expect(fuzzyFilter("ideas", items, matchText).map((r) => r.item.path)).toEqual([
      "ideas",
    ]);
  });

  it("matches folder segments of the path", () => {
    expect(fuzzyFilter("recipes", items, matchText).map((r) => r.item.path)).toEqual([
      "folders/dad/recipes/soup",
    ]);
    expect(fuzzyFilter("dad", items, matchText).map((r) => r.item.path)).toEqual([
      "folders/dad/recipes/soup",
    ]);
    expect(fuzzyFilter("folders", items, matchText).map((r) => r.item.path)).toEqual([
      "folders/dad/recipes/soup",
    ]);
  });

  it("ranks a title hit above a folder-only hit", () => {
    const ranked = [
      { path: "stories/recipes-book", title: "Recipes Book", aliases: [] },
      ...items,
    ];
    expect(
      fuzzyFilter("recipes", ranked, matchText).map((r) => r.item.path),
    ).toEqual(["stories/recipes-book", "folders/dad/recipes/soup"]);
  });

  it("returns items in order for empty query", () => {
    const out = fuzzyFilter("", items, matchText);
    expect(out).toHaveLength(2);
  });
});
