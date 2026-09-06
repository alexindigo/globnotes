// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { replaceAll } from "@milkdown/utils";

import {
  extractFrontmatter,
  frontmatterDocSchema,
  frontmatterFallbackView,
  frontmatterRemark,
  frontmatterSchema,
} from "../frontmatter-node.js";

// Corruption regression pins: WYSIWYG save used to corrupt frontmatter
// (`---` → `***`, YAML parsed as a setext heading, `[` escaped). The core
// frontmatter node must round-trip the block verbatim.

function makeEditor(initialValue) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  return Editor.make()
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
    .create();
}

async function makeEditorWith(initialValue) {
  const editor = await makeEditor(initialValue);
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const getMarkdown = () =>
    editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
  return { editor, view, getMarkdown };
}

describe("core frontmatter node", () => {
  const mounts = () => document.querySelectorAll(".milkdown");
  afterEach(() => mounts().forEach((m) => m.remove()));

  it("extracts a position-0 fenced block", () => {
    expect(extractFrontmatter("---\ntitle: x\n---\n\nbody")).toEqual({
      yaml: "title: x",
      end: 17,
    });
    expect(extractFrontmatter("---\n---")).toEqual({ yaml: "", end: 7 });
    expect(extractFrontmatter("\n---\ntitle: x\n---")).toBeNull();
    expect(extractFrontmatter("# just a note\n---")).toBeNull();
  });

  it("parses the frontmatter node at position 0 (no setext heading, no thematic break)", async () => {
    const { view } = await makeEditorWith("---\ntitle: hello\n---\n\n# hi\n");
    const first = view.state.doc.firstChild;
    expect(first.type.name).toBe("frontmatter");
    expect(first.attrs.value).toBe("title: hello");
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.lastChild.type.name).toBe("heading");
  });

  it("keeps mid-document `---` as a thematic break (position-0 parser only)", async () => {
    const { view } = await makeEditorWith("# hi\n\n---\n\nbody\n");
    expect(view.state.doc.firstChild.type.name).toBe("heading");
    const names = [];
    view.state.doc.forEach((n) => names.push(n.type.name));
    expect(names).not.toContain("frontmatter");
  });

  it("round-trips frontmatter verbatim (no `***`, no escaping)", async () => {
    const SRC =
      '---\ntitle: Note: [bracketed]\ntags: [a, b]\nmeta:\n  nested: true\n---\n\n# hi\n\nbody text\n';
    const { getMarkdown } = await makeEditorWith(SRC);
    const out = getMarkdown();
    expect(out).toContain("---\ntitle: Note: [bracketed]");
    expect(out).not.toContain("***");
    expect(out).toContain("tags: [a, b]");
    expect(out).toContain("meta:\n  nested: true");
    expect(out).not.toContain("\\[");
  });

  it("is idempotent across editor mode toggles (serialize → reparse → serialize)", async () => {
    const SRC = "---\ntitle: hello\ntags: [a, b]\n---\n\n# hi\n\nbody\n";
    const { editor, getMarkdown } = await makeEditorWith(SRC);
    const once = getMarkdown();
    // Simulate a mode toggle: replaceAll re-parses the serialized source
    // (the same path WysiwygEditorInner.setMarkdown uses).
    editor.action(replaceAll(once));
    const twice = getMarkdown();
    expect(twice).toBe(once);
  });

  it("handles a frontmatter-only document (no body)", async () => {
    const { view, getMarkdown } = await makeEditorWith("---\ntitle: only\n---\n");
    const names = [];
    view.state.doc.forEach((n) => names.push(n.type.name));
    expect(names[0]).toBe("frontmatter");
    expect(getMarkdown()).toContain("title: only");
  });

  it("mounts the framed read-only fallback view", async () => {
    const { view } = await makeEditorWith("---\ntitle: x\n---\n\nbody\n");
    const dom = view.dom.querySelector(".frontmatter-fallback");
    expect(dom).toBeTruthy();
    // Framed, read-only rendering of the raw YAML (atom nodeView: ProseMirror
    // manages editability; no editable contentDOM exists).
    expect(dom.querySelector("pre")?.textContent).toBe("title: x");
  });
});
