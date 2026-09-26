// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { sanitizeBasename } from "@globnotes/names";
import {
  bufferTitleOf,
  firstH1Of,
  frontmatterTitleOf,
} from "../noteTitle.js";
import { initDocTitle, setDocTitleBase } from "../title.js";
import { publish, TOPICS } from "../bus/index.js";
import { useGlobalStore } from "../globalStore.js";

describe("noteTitle helpers", () => {
  it("first H1 wins, frontmatter block skipped", () => {
    expect(firstH1Of("---\ntags: [x]\n---\n\n# Hello World\n")).toBe(
      "Hello World",
    );
    expect(firstH1Of("plain text\n\n# Later\n")).toBe("Later");
    expect(firstH1Of("no headings")).toBe(null);
  });

  it("frontmatter title beats the H1", () => {
    expect(
      bufferTitleOf('---\ntitle: "Real Title"\n---\n\n# Something Else\n'),
    ).toBe("Real Title");
    expect(bufferTitleOf("# Just A Heading\n")).toBe("Just A Heading");
    expect(frontmatterTitleOf("---\ntags: [x]\n---\n# H\n")).toBe(null);
  });

  it("sanitizeBasename is the shared rule", () => {
    expect(sanitizeBasename("Hello World!")).toBe("Hello World!");
    expect(sanitizeBasename("a/b:c")).toBe("abc");
    expect(sanitizeBasename("...")).toBe(null);
    expect(sanitizeBasename("  spaced   out ")).toBe("spaced out");
  });
});

describe("document.title owner", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    initDocTitle();
    setDocTitleBase();
  });

  it("non-note pages carry the bare brand", () => {
    expect(document.title).toBe("globnotes");
  });

  it("an open note's live title composes with the brand", () => {
    publish(TOPICS.NOTE_TITLE_CHANGED, { title: "Hello World" });
    expect(document.title).toBe("Hello World - globnotes");
  });

  it("leaving the note resets to the base", () => {
    publish(TOPICS.NOTE_TITLE_CHANGED, { title: "Hello World" });
    setDocTitleBase();
    expect(document.title).toBe("globnotes");
  });
});
