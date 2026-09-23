// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { classifyAnchorClick } from "../components/ServerViewer.vue";

const NOTE = "http://localhost:8080/anchors";

describe("classifyAnchorClick", () => {
  it("bare in-page anchor → same-page-anchor", () => {
    expect(classifyAnchorClick("#section-one", NOTE)).toBe("same-page-anchor");
  });

  it("empty fragment → same-page-anchor (harmless no-op)", () => {
    expect(classifyAnchorClick("#", NOTE)).toBe("same-page-anchor");
  });

  it("app fragments stay router entries (#view:L5, #source)", () => {
    expect(classifyAnchorClick("#view:L5", NOTE)).toBe("app-fragment");
    expect(classifyAnchorClick("#source", NOTE)).toBe("app-fragment");
    expect(classifyAnchorClick("#edit", NOTE)).toBe("app-fragment");
  });

  it("different note path → cross-page", () => {
    expect(classifyAnchorClick("/other-note", NOTE)).toBe("cross-page");
    expect(classifyAnchorClick("other-note", NOTE)).toBe("cross-page");
  });

  it("same path with different query → cross-page", () => {
    expect(classifyAnchorClick("/anchors?x=1#section-one", NOTE)).toBe(
      "cross-page",
    );
  });

  it("external URL → cross-page", () => {
    expect(classifyAnchorClick("https://example.com", NOTE)).toBe(
      "cross-page",
    );
  });

  it("path prefix deployments: same note under the prefix → same-page", () => {
    const prefixed = "http://localhost:8080/mom/anchors";
    expect(classifyAnchorClick("#section-one", prefixed)).toBe(
      "same-page-anchor",
    );
    expect(classifyAnchorClick("#view:L3", prefixed)).toBe("app-fragment");
  });
});
