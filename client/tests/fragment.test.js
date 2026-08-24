import { describe, expect, it } from "vitest";
import { parseFragment, serializeFragment } from "../fragment.js";

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
    expect(parseFragment("#view:L5")).toEqual({ mode: null, line: null });
    expect(parseFragment("#bogus")).toEqual({ mode: null, line: null });
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
