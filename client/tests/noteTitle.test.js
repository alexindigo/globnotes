import { describe, expect, it } from "vitest";
import { displayTitle, followedBasename } from "../noteTitle.js";

describe("displayTitle", () => {
  it.each([
    ['---\ntitle: "Frontmatter"\n---\n# Heading', "Filename", "Frontmatter"],
    ["---\ntitle: 'Frontmatter'\n---\n# Heading", "Filename", "Frontmatter"],
    ["---\ntitle: Plain title\n---\n# Heading", "Filename", "Plain title"],
    ["---\r\ntitle: Windows title\r\n---\r\n# Heading", "Filename", "Windows title"],
    ["---\ntags: [x]\n---\n# Heading", "Filename", "Heading"],
    ["# First\n\n# Second", "Filename", "First"],
    ["## Subheading\n\n# Main heading", "Filename", "Main heading"],
    ["# a/b:c", "Filename", "a/b:c"],
    ['---\ntitle: ""\n---\n# Heading', "Filename", "Heading"],
    ["No title in this buffer", "Filename", "Filename"],
    ["", "Filename", "Filename"],
    [null, "Filename", "Filename"],
    [undefined, "Filename", "Filename"],
    ["", "", "Untitled"],
    [null, undefined, "Untitled"],
  ])("resolves buffer %j with basename %j to %j", (buffer, basename, expected) => {
    expect(displayTitle(buffer, basename)).toBe(expected);
  });
});

describe("followedBasename", () => {
  it.each([
    ["# Heading", "Heading"],
    ["# First\n# Second", "First"],
    ["---\ntags: [x]\n---\n# Heading", "Heading"],
    ["# a/b:c", "abc"],
    ['# a<>:"\\|?/*b', "ab"],
    ["#   spaced   out ", "spaced out"],
    // The shared sanitizer trims before removing dots, retaining this space.
    ["# ...  spaced   out", " spaced out"],
    ["# 笔记", "笔记"],
    ["# " + "x".repeat(300), "x".repeat(255)],
    ["# ...", null],
    ["# <>:" + "\\|?/*", null],
    ["## Not an H1", null],
    ["No heading", null],
    [null, null],
    [undefined, null],
    ['---\ntitle: "Explicit"\n---\n# Heading', null],
    ["---\ntitle: ...\n---\n# Heading", null],
    ['---\ntitle: ""\n---\n# Heading', "Heading"],
  ])("maps buffer %j to filename candidate %j", (buffer, expected) => {
    expect(followedBasename(buffer)).toBe(expected);
  });
});
