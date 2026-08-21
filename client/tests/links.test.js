// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  rewriteMarkdownLinks,
  rewriteRenamedLinks,
  rewriteWikilinks,
} from "../links.js";

describe("rewriteWikilinks", () => {
  it("rewrites plain links", () => {
    expect(rewriteWikilinks("see [[target/note]]", "target/note", "target/renamed")).toBe(
      "see [[target/renamed]]",
    );
  });

  it("preserves aliases and heading anchors", () => {
    const out = rewriteWikilinks(
      "see [[target/note|the alias]] and [[target/note#Section]]",
      "target/note",
      "target/renamed",
    );
    expect(out).toContain("[[target/renamed|the alias]]");
    expect(out).toContain("[[target/renamed#Section]]");
  });

  it("does not touch embeds (file references)", () => {
    const out = rewriteWikilinks("![[pic.png]]", "pic.png", "moved/pic.png");
    expect(out).toBe("![[pic.png]]");
  });

  it("does not touch basename-only links", () => {
    const out = rewriteWikilinks("see [[note]]", "target/note", "target/renamed");
    expect(out).toBe("see [[note]]");
  });

  it("does not touch longer titles that share a prefix", () => {
    const out = rewriteWikilinks("see [[target/notebook]]", "target/note", "target/renamed");
    expect(out).toBe("see [[target/notebook]]");
  });
});

describe("rewriteMarkdownLinks", () => {
  it("rewrites absolute links", () => {
    const out = rewriteMarkdownLinks(
      "see [t](/target/note.md)",
      "target/note",
      "target/renamed",
      "probe/source",
    );
    expect(out).toBe("see [t](/target/renamed.md)");
  });

  it("rewrites relative links resolved against the referencing note's folder", () => {
    const out = rewriteMarkdownLinks(
      "see [t](../target/note.md)",
      "target/note",
      "target/renamed",
      "probe/source",
    );
    expect(out).toBe("see [t](../target/renamed.md)");
  });

  it("does not touch links to other notes", () => {
    const out = rewriteMarkdownLinks(
      "see [t](/other/note.md)",
      "target/note",
      "target/renamed",
      "probe/source",
    );
    expect(out).toBe("see [t](/other/note.md)");
  });

  it("does not touch external links", () => {
    const out = rewriteMarkdownLinks(
      "see [t](https://example.com/target/note.md)",
      "target/note",
      "target/renamed",
      "probe/source",
    );
    expect(out).toBe("see [t](https://example.com/target/note.md)");
  });

  it("rebases across folders when the rename moves deeper", () => {
    const out = rewriteMarkdownLinks(
      "see [t](note.md)",
      "note",
      "a/b/note",
      "probe/source",
    );
    // note.md from probe/ resolves to probe/note.md -- not a match, untouched
    expect(out).toBe("see [t](note.md)");
  });
});

describe("rewriteRenamedLinks", () => {
  it("does both forms in one pass", () => {
    const out = rewriteRenamedLinks(
      "wiki [[target/note]] and md [t](/target/note.md)",
      "target/note",
      "target/renamed",
      "probe/source",
    );
    expect(out).toContain("[[target/renamed]]");
    expect(out).toContain("[t](/target/renamed.md)");
  });
});
