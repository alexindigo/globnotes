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
  const matchText = (n) => [n.title, ...(n.aliases || []), n.path.split("/").pop()];

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

  it("returns items in order for empty query", () => {
    const out = fuzzyFilter("", items, matchText);
    expect(out).toHaveLength(2);
  });
});
