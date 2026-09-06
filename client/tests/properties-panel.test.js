// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { replaceAll } from "@milkdown/utils";

import {
  frontmatterDocSchema,
  frontmatterFallbackView,
  frontmatterRemark,
  frontmatterSchema,
} from "../frontmatter-node.js";
// The real dual-mode client module (exactly what the loader imports).
import clientPlugins from "../../plugins/globnotes-properties/client.js";

async function makeEditor(initialValue) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, mount);
      ctx.set(defaultValueCtx, initialValue);
    })
    .use(commonmark)
    .use(gfm)
    .use(frontmatterRemark)
    .use(frontmatterSchema)
    .use(frontmatterDocSchema)
    .use(frontmatterFallbackView)
    // The contract's spread order: client modules LAST (their $view
    // overrides the core fallback view).
    .use(clientPlugins)
    .create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const getMarkdown = () =>
    editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
  return { editor, view, getMarkdown };
}

describe("globnotes-properties client half", () => {
  const mounts = () => document.querySelectorAll(".milkdown");
  afterEach(() => mounts().forEach((m) => m.remove()));

  it("exports an array of plugin factories (the contract)", () => {
    expect(Array.isArray(clientPlugins)).toBe(true);
    expect(clientPlugins.length).toBeGreaterThan(0);
    for (const factory of clientPlugins) {
      expect(typeof factory).toBe("function");
    }
  });

  it("overrides the core fallback view with the interactive panel", async () => {
    const { view } = await makeEditor("---\ntitle: hello\ntags: [a, b]\n---\n\nbody\n");
    expect(view.dom.querySelector(".properties-panel")).toBeTruthy();
    expect(view.dom.querySelector(".frontmatter-fallback")).toBeNull();
    const rows = view.dom.querySelectorAll(".properties-row");
    expect(rows.length).toBe(2);
    const titleInput = view.dom.querySelector('.properties-row[data-key="title"] .properties-value-input');
    expect(titleInput?.value).toBe("hello");
    const chips = [...view.dom.querySelectorAll(".properties-chip > span")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["a", "b"]);
  });

  it("edits dispatch through the node and serialize back to YAML", async () => {
    const { view, getMarkdown } = await makeEditor("---\ntitle: hello\n---\n\nbody\n");
    const titleInput = view.dom.querySelector(
      '.properties-row[data-key="title"] .properties-value-input',
    );
    titleInput.value = "edited title";
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    const out = getMarkdown();
    expect(out).toContain("title: edited title");
    expect(out).toContain("---");
    expect(out).not.toContain("hello");
  });

  it("removes chips via × and round-trips", async () => {
    const { view, getMarkdown } = await makeEditor(
      "---\ntags: [one, two]\n---\n\nbody\n",
    );
    const chipRemoves = [...view.dom.querySelectorAll(".properties-chip-remove")];
    expect(chipRemoves.length).toBe(2);
    chipRemoves[0].click();
    expect(getMarkdown()).toContain("tags:\n- two");
  });

  it("shows the empty-state affordance and creates the block at position 0", async () => {
    const { editor, view, getMarkdown } = await makeEditor("# just a note\n");
    expect(view.dom.querySelector(".properties-panel")).toBeNull();
    const button = view.dom.querySelector(".properties-empty .properties-add");
    expect(button).toBeTruthy();
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const first = view.state.doc.firstChild;
    expect(first.type.name).toBe("frontmatter");
    expect(getMarkdown()).toMatch(/^---\n\n---/);
    // Panel appears for the new block.
    expect(view.dom.querySelector(".properties-panel")).toBeTruthy();
    void editor;
  });

  it("external content transfer re-parses the panel (mode-toggle path)", async () => {
    const { editor, view } = await makeEditor("---\ntitle: one\n---\n\nbody\n");
    editor.action(replaceAll("---\ntitle: two\n---\n\nbody\n"));
    const titleInput = view.dom.querySelector(
      '.properties-row[data-key="title"] .properties-value-input',
    );
    expect(titleInput?.value).toBe("two");
  });
});

// Chip-add / autocomplete affordance (the concilium dissolve pins): the
// adder is built ONCE per tags row — construction attaches the input and
// menu, re-renders REUSE the same nodes, never rebuild them.
describe("chip-add affordance", () => {
  // The panel module memoizes the tags fetch at module scope; the stub
  // must be in place before any focus triggers it.
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(["alpha", "beta", "vaulttag", "othertag"]),
        })
      ),
    );
  });
  afterAll(() => vi.unstubAllGlobals());

  const SRC = "---\ntitle: hello\ntags: [alpha, beta]\n---\n\nbody\n";
  const tagsRow = (view) =>
    view.dom.querySelector('.properties-row[data-key="tags"]');

  it("mounts the adder input and menu on initial render (menu hidden)", async () => {
    const { view } = await makeEditor(SRC);
    const row = tagsRow(view);
    const input = row.querySelector(".properties-chip-adder .properties-chip-input");
    expect(input).toBeTruthy();
    const menu = row.querySelector(".properties-chip-adder .properties-menu");
    expect(menu).toBeTruthy();
    expect(menu.hidden).toBe(true);
  });

  it("focus surfaces vault tag suggestions, filtering existing tags", async () => {
    const { view } = await makeEditor(SRC);
    const input = tagsRow(view).querySelector(".properties-chip-input");
    input.focus();
    await vi.waitFor(() => {
      const menu = tagsRow(view).querySelector(".properties-menu");
      expect(menu.hidden).toBe(false);
    });
    const items = [...tagsRow(view).querySelectorAll(".properties-menu-item")].map(
      (m) => m.textContent,
    );
    // Existing tags (alpha, beta) are filtered out of the suggestions.
    expect(items).toEqual(["vaulttag", "othertag"]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/_/api/tags");
  });

  it("Enter adds the typed item; markdown and adder survive the re-render", async () => {
    const { view, getMarkdown } = await makeEditor(SRC);
    const input = tagsRow(view).querySelector(".properties-chip-input");
    input.value = "fresh-tag";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(getMarkdown()).toContain("fresh-tag");
    // The adder is still mounted after the re-render.
    expect(tagsRow(view).querySelector(".properties-chip-input")).toBeTruthy();
  });

  it("re-renders REUSE the same adder node (identity pin)", async () => {
    const { view, getMarkdown } = await makeEditor(SRC);
    const adder = tagsRow(view).querySelector(".properties-chip-adder");
    // Add: Enter on the typed input.
    const input = tagsRow(view).querySelector(".properties-chip-input");
    input.value = "fresh-tag";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tagsRow(view).querySelector(".properties-chip-adder")).toBe(adder);
    // Remove: the × on a chip (now chipFor-built) re-renders again.
    const chip = [...tagsRow(view).querySelectorAll(".properties-chip")].find((c) =>
      c.textContent.startsWith("fresh-tag"),
    );
    chip.querySelector(".properties-chip-remove").click();
    expect(getMarkdown()).not.toContain("fresh-tag");
    expect(tagsRow(view).querySelector(".properties-chip-adder")).toBe(adder);
  });
});
