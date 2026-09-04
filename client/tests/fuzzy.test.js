import { describe, expect, it } from "vitest";
import {
  fuzzyFilter,
  fuzzyScore,
  highlightSegments,
  windowAroundMatch,
} from "../fuzzy.js";

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

const items = [
  { path: "folders/dad/recipes/soup", title: "Soup", aliases: ["broth"] },
  { path: "ideas", title: "Ideas", aliases: [] },
];
// Mirrors SwitcherPanel's matchText: weighted kind-tagged candidates —
// title > alias > file (basename) > path (folder segments).
const matchText = (n) => [
  { text: n.title, weight: 1.5, kind: "title" },
  ...(n.aliases || []).map((alias) => ({
    text: alias,
    weight: 1.4,
    kind: "alias",
  })),
  { text: n.path.split("/").pop(), weight: 1.3, kind: "file" },
  { text: n.path, weight: 1, kind: "path" },
];

describe("fuzzyFilter", () => {

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

  it("ranks a contiguous folder-segment match above a scattered title subsequence", () => {
    // Vault example: "mom" is a contiguous run inside the folder segment of
    // folders/mom/ideas, but only a scattered m…o…m subsequence of the
    // long "Switcher alignment — geometry decomposition" title.
    const ranked = [
      {
        path: "notes/switcher-alignment",
        title: "Switcher alignment — geometry decomposition",
        aliases: [],
      },
      { path: "folders/mom/ideas", title: "Ideas", aliases: [] },
    ];
    expect(fuzzyFilter("mom", ranked, matchText).map((r) => r.item.path)).toEqual([
      "folders/mom/ideas",
      "notes/switcher-alignment",
    ]);
  });

  it("ranks a filename hit above a folder-segment hit", () => {
    // The user's scenario: mom.md is the file they want; a note living in
    // a folder named mom is less important — even though the folder match
    // sits earlier in its path (raw scores alone would invert this).
    const ranked = [
      { path: "notes/mom/readme", title: "readme", aliases: [] },
      { path: "notes/docs/mom", title: "Shopping list", aliases: [] },
    ];
    expect(fuzzyFilter("mom", ranked, matchText).map((r) => r.item.path)).toEqual([
      "notes/docs/mom",
      "notes/mom/readme",
    ]);
  });

  it("returns items in order for empty query", () => {
    const out = fuzzyFilter("", items, matchText);
    expect(out).toHaveLength(2);
  });
});

describe("fuzzyFilter matchedText", () => {
  it("returns the winning candidate string", () => {
    // "recipes" only matches the path of the soup note.
    expect(fuzzyFilter("recipes", items, matchText)[0].matchedText).toBe(
      "folders/dad/recipes/soup",
    );
  });

  it("returns the title when it wins", () => {
    const ranked = [
      { path: "stories/recipes-book", title: "Recipes Book", aliases: [] },
      ...items,
    ];
    expect(fuzzyFilter("recipes", ranked, matchText)[0].matchedText).toBe(
      "Recipes Book",
    );
  });

  it("returns an alias when it wins", () => {
    expect(fuzzyFilter("broth", items, matchText)[0].matchedText).toBe("broth");
  });

  it("is null for an empty query", () => {
    expect(fuzzyFilter("", items, matchText)[0].matchedText).toBeNull();
  });

  it("tags the winning candidate's kind", () => {
    const ranked = [
      { path: "notes/docs/mom", title: "Shopping list", aliases: [] },
      { path: "notes/mom/readme", title: "readme", aliases: [] },
    ];
    const out = fuzzyFilter("mom", ranked, matchText);
    expect(out[0].matchedKind).toBe("file");
    expect(out[1].matchedKind).toBe("path");
  });
});

describe("windowAroundMatch", () => {
  it("returns short text untouched", () => {
    expect(windowAroundMatch("folders/mom/ideas", [8, 9, 10])).toEqual({
      text: "folders/mom/ideas",
      positions: [8, 9, 10],
      elidedStart: false,
    });
  });

  it("handles empty positions", () => {
    expect(windowAroundMatch("abc", [])).toEqual({
      text: "abc",
      positions: [],
      elidedStart: false,
    });
  });

  it("windows long text around the first match", () => {
    const path = "a/very/long/folder/chain/before/the/match/mom/x";
    const w = windowAroundMatch(path, [42, 43, 44], 30);
    expect(w.elidedStart).toBe(true);
    expect(w.text.startsWith("…")).toBe(true);
    expect(w.text.slice(1)).toBe(path.slice(17));
    expect(w.positions).toEqual([26, 27, 28]);
  });
});

describe("highlightSegments", () => {
  it("splits text into matched and unmatched runs", () => {
    expect(highlightSegments("folders/mom/ideas", [8, 9, 10])).toEqual([
      { text: "folders/", matched: false },
      { text: "mom", matched: true },
      { text: "/ideas", matched: false },
    ]);
  });

  it("handles empty positions", () => {
    expect(highlightSegments("abc", [])).toEqual([{ text: "abc", matched: false }]);
  });

  it("handles a fully matched string", () => {
    expect(highlightSegments("mom", [0, 1, 2])).toEqual([{ text: "mom", matched: true }]);
  });

  it("handles scattered positions", () => {
    expect(highlightSegments("alignment", [5, 8])).toEqual([
      { text: "align", matched: false },
      { text: "m", matched: true },
      { text: "en", matched: false },
      { text: "t", matched: true },
    ]);
  });
});
