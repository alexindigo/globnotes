// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../router.js", () => ({ default: { push: vi.fn() } }));

import { classifyAnchorClick, handleAnchorClick } from "../anchorClicks.js";
import router from "../router.js";

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

describe("shared rendered-markdown click handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("location", { href: NOTE });
    vi.stubGlobal("CSS", { escape: vi.fn(value => value.replaceAll('"', '\\"')) });
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  function click(href) {
    const link = document.createElement("a");
    link.setAttribute("href", href);
    const child = document.createElement("span");
    link.appendChild(child);
    return { target: child, preventDefault: vi.fn() };
  }

  it("ignores clicks outside links", async () => {
    const event = { target: document.createElement("p"), preventDefault: vi.fn() };
    await handleAnchorClick(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("leaves cross-page navigation to the browser", async () => {
    const event = click("/other-note#heading");
    await handleAnchorClick(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("scrolls decoded element ids without adding a router history entry", async () => {
    const target = document.createElement("h2");
    target.id = "section one";
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    const event = click("#section%20one");
    await handleAnchorClick(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("falls back to escaped named anchors", async () => {
    const target = document.createElement("a");
    target.name = 'section"one';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    const event = click("#section%22one");
    await handleAnchorClick(event);
    expect(CSS.escape).toHaveBeenCalledExactlyOnceWith('section"one');
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("tolerates a missing anchor target", async () => {
    const event = click("#missing");
    await expect(handleAnchorClick(event)).resolves.toBeUndefined();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each(["#source", "#edit", "#view:L5"])("routes app fragment %s with prefix and query intact", async hash => {
    vi.stubGlobal("location", { href: "http://globnotes.home/mom/anchors?option=1" });
    const event = click(hash);
    await handleAnchorClick(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/mom/anchors?option=1${hash}`);
  });
});
