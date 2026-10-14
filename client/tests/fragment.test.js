import { describe, expect, it } from "vitest";
import {
  editorStateFromFragment,
  parseFragment,
  serializeFragment,
  viewLineFromFragment,
} from "../fragment.js";

describe("parseFragment", () => {
  it("parses mode segments", () => {
    expect(parseFragment("#edit")).toEqual({ mode: "edit", line: null });
    expect(parseFragment("#source")).toEqual({ mode: "source", line: null });
  });

  it("parses the line aspect", () => {
    expect(parseFragment("#source:L12")).toEqual({
      mode: "source",
      line: { from: 12, to: 12 },
    });
    expect(parseFragment("#source:L12-34")).toEqual({
      mode: "source",
      line: { from: 12, to: 34 },
    });
  });

  it("tolerates a stray second L while parsing", () => {
    expect(parseFragment("#source:L12-L34")).toEqual({
      mode: "source",
      line: { from: 12, to: 34 },
    });
  });

  it("ignores further aspects", () => {
    expect(parseFragment("#source:L12-34:something-else")).toEqual({
      mode: "source",
      line: { from: 12, to: 34 },
    });
  });

  it("ignores the line aspect on edit mode", () => {
    expect(parseFragment("#edit:L5")).toEqual({ mode: "edit", line: null });
  });

  it("clamps inverted ranges", () => {
    expect(parseFragment("#source:L34-12")).toEqual({
      mode: "source",
      line: { from: 12, to: 34 },
    });
  });

  it("rejects unknown modes — bare line links included", () => {
    expect(parseFragment("#L12")).toEqual({ mode: null, line: null });
    expect(parseFragment("#L12-34")).toEqual({ mode: null, line: null });
    expect(parseFragment("#bogus")).toEqual({ mode: null, line: null });
  });

  it("parses the view mode with its line aspect", () => {
    expect(parseFragment("#view")).toEqual({ mode: "view", line: null });
    expect(parseFragment("#view:L5")).toEqual({
      mode: "view",
      line: { from: 5, to: 5 },
    });
    expect(parseFragment("#view:L5-34")).toEqual({
      mode: "view",
      line: { from: 5, to: 34 },
    });
  });

  it("keeps a valid mode when the line aspect is malformed", () => {
    expect(parseFragment("#source:Lnonsense")).toEqual({
      mode: "source",
      line: null,
    });
  });

  it("returns empty for missing input", () => {
    expect(parseFragment("")).toEqual({ mode: null, line: null });
    expect(parseFragment(null)).toEqual({ mode: null, line: null });
    expect(parseFragment(undefined)).toEqual({ mode: null, line: null });
  });
});

describe("serializeFragment", () => {
  it("serializes modes and line aspects", () => {
    expect(serializeFragment({ mode: null })).toBe("");
    expect(serializeFragment(null)).toBe("");
    expect(serializeFragment({ mode: "edit" })).toBe("#edit");
    expect(serializeFragment({ mode: "source" })).toBe("#source");
    expect(serializeFragment({ mode: "source", line: { from: 12, to: 12 } })).toBe(
      "#source:L12",
    );
    expect(
      serializeFragment({ mode: "source", line: { from: 103, to: 184 } }),
    ).toBe("#source:L103-184");
  });

  it("drops the line aspect on edit mode", () => {
    expect(
      serializeFragment({ mode: "edit", line: { from: 1, to: 2 } }),
    ).toBe("#edit");
  });
});

describe("round-trip", () => {
  it("parse ∘ serialize is stable on canonical forms", () => {
    for (const hash of ["#edit", "#source", "#source:L5", "#source:L103-184"]) {
      expect(serializeFragment(parseFragment(hash))).toBe(hash);
    }
  });

  it("normalizes the tolerated L-L form to the canonical form", () => {
    expect(serializeFragment(parseFragment("#source:L12-L34"))).toBe(
      "#source:L12-34",
    );
  });
});

describe("editorStateFromFragment", () => {
  it.each([
    ["#edit", { mode: "wysiwyg", line: null }],
    ["#edit:L5", { mode: "wysiwyg", line: null }],
    ["#source", { mode: "markdown", line: null }],
    ["#source:L12", { mode: "markdown", line: { from: 12, to: 12 } }],
    ["#source:L34-L12", { mode: "markdown", line: { from: 12, to: 34 } }],
    ["#source:L0", { mode: "markdown", line: { from: 1, to: 1 } }],
    ["#source:Lnonsense", { mode: "markdown", line: null }],
    ["#view", null],
    ["#view:L12-34", null],
    ["#L12", null],
    ["#bogus", null],
    ["", null],
  ])("maps %s to pending edit entry %j", (hash, expected) => {
    expect(editorStateFromFragment(parseFragment(hash))).toEqual(expected);
  });

  it.each(["markdown", "wysiwyg", "preview"])(
    "maps edit navigation from %s to WYSIWYG without a line",
    (mode) => {
      expect(editorStateFromFragment(parseFragment("#edit:L5"), mode)).toEqual({
        mode: "wysiwyg", line: null,
      });
    },
  );

  it.each([
    ["markdown", "markdown"],
    ["wysiwyg", "markdown"],
    ["preview", "preview"],
  ])("maps source navigation from %s to %s and retains its line", (mode, expected) => {
    const fragment = parseFragment("#source:L5-8");
    const before = { ...fragment, line: { ...fragment.line } };
    expect(editorStateFromFragment(fragment, mode)).toEqual({
      mode: expected, line: { from: 5, to: 8 },
    });
    expect(fragment).toEqual(before);
  });
});

describe("viewLineFromFragment", () => {
  it.each([
    ["#view:L5", { from: 5, to: 5 }],
    ["#view:L34-12", { from: 12, to: 34 }],
    ["#view", null],
    ["#view:Lnonsense", null],
    ["#edit", null],
    ["#source:L5", null],
    ["#bogus", null],
    ["", null],
  ])("maps %s to initial view highlight %j", (hash, expected) => {
    expect(viewLineFromFragment(parseFragment(hash))).toEqual(expected);
  });

  it.each(["#view", "#view:Lnonsense", "#bogus", "#L12", ""])(
    "clears an existing highlight for %s",
    (hash) => {
      expect(viewLineFromFragment(parseFragment(hash), { from: 1, to: 3 })).toBeNull();
    },
  );

  it.each(["#edit", "#source", "#source:L5"])(
    "leaves an existing view highlight untouched for %s",
    (hash) => {
      const existing = { from: 1, to: 3 };
      expect(viewLineFromFragment(parseFragment(hash), existing)).toBe(existing);
    },
  );

  it("replaces an existing highlight with a view line range", () => {
    expect(viewLineFromFragment(parseFragment("#view:L5-8"), { from: 1, to: 3 }))
      .toEqual({ from: 5, to: 8 });
  });
});
