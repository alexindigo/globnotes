// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Render pipeline tests — markdown-it default rendering (no plugins),
 * the five default worker plugins, vault plugin dispatch, plugins.json
 * ordering, and the render endpoint end-to-end.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { renderMarkdown } from "../server/render/pipeline.ts";
import { initState } from "../server/state.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { bootServer } from "./helpers/boot.ts";

function setupState(vault: string, plugins: PluginManager | null): void {
  Deno.env.set("GLOBNOTES_PATH", vault);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  const config = new GlobalConfig();
  const notes = new FileSystemNotes(vault);
  const indexer = new Fts5Indexer(vault);
  notes.setIndexer(indexer);
  indexer.bindNotes(notes);
  initState(
    config,
    null,
    notes,
    indexer,
    new FileServing(vault),
    plugins,
  );
  indexer.bindPlugins(plugins);
}

Deno.test("render: default markdown-it output (no plugins)", async () => {
  const vault = await Deno.makeTempDir();
  try {
    setupState(vault, null);

    // Rendered lines carry view-mode line identities: data-source-line
    // (rendered-line → source-line map) + data-line (the L link form).
    // For headings the id attribute is injected before the line tags.
    assertEquals(
      await renderMarkdown("# Hello World\n\nSome *text*."),
      `<h1 data-source-line="0" data-line="L1" id="hello-world">Hello World</h1>\n` +
        `<p data-source-line="2" data-line="L3">Some <em>text</em>.</p>\n`,
    );

    // Prism highlight for known languages.
    const fenced = await renderMarkdown("```js\nlet x = 1;\n```");
    assertStringIncludes(fenced, `class="language-js"`);
    assertStringIncludes(fenced, "token");

    // Unknown language → escaped plain.
    const plain = await renderMarkdown("```nope\n<a>\n```");
    assertStringIncludes(plain, "&lt;a&gt;");

    // Front matter box.
    const fm = await renderMarkdown("---\ntitle: Doc\n---\nbody");
    assertStringIncludes(fm, `<div class="front-matter">`);
    assertStringIncludes(fm, "title: Doc");
    assertStringIncludes(fm, '<p data-source-line="3" data-line="L4">body</p>');

    // Raw HTML passes through; linkify on.
    assertStringIncludes(
      await renderMarkdown("<span>x</span> https://example.com"),
      '<span>x</span> <a href="https://example.com">',
    );
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("render: default plugins", async (t) => {
  const vault = await Deno.makeTempDir();
  try {
    const manager = new PluginManager(vault, undefined, 1);
    setupState(vault, manager);
    try {
      await t.step("comments stripped, fences untouched", async () => {
        const html = await renderMarkdown(
          "shown %%hidden%% text\n\n```\n%%kept%%\n```",
        );
        assertStringIncludes(html, "shown  text");
        assert(!html.includes("hidden"));
        assertStringIncludes(html, "%%kept%%");
      });

      await t.step("embeds", async () => {
        const html = await renderMarkdown(
          "![[img.png]] and ![[doc.pdf|The Doc]]",
        );
        assertStringIncludes(html, '<img src="img.png"');
        assertStringIncludes(html, '<a href="doc.pdf">The Doc</a>');
      });

      await t.step("embed inside code span is NOT transformed", async () => {
        const html = await renderMarkdown("`![[img.png]]`");
        assert(!html.includes("<img"));
      });

      await t.step("mark", async () => {
        const html = await renderMarkdown("a ==b== c");
        assertStringIncludes(html, "a <mark>b</mark> c");
      });

      await t.step("callout", async () => {
        const html = await renderMarkdown("> [!warning] Careful\n> body");
        assertStringIncludes(html, 'class="callout callout-warning"');
        assertStringIncludes(html, "Careful");
        assert(!html.includes("[!warning]"));
      });

      await t.step("non-callout blockquote stays default", async () => {
        const html = await renderMarkdown("> plain quote");
        assertStringIncludes(html, "<blockquote data-source-line=");
        assert(!html.includes("callout"));
      });

      await t.step("front matter → Properties panel markup", async () => {
        const html = await renderMarkdown(
          "---\ntitle: Doc\ntags: [a, b]\nmeta:\n  nested: true\n---\nbody",
        );
        assertStringIncludes(html, 'class="properties-panel"');
        assertStringIncludes(html, 'data-key="title"');
        assertStringIncludes(html, ">Doc</span>");
        // List values render as chips.
        assertStringIncludes(html, 'class="properties-chip">a</span>');
        assertStringIncludes(html, 'class="properties-chip">b</span>');
        // Complex values pass through verbatim (raw kind).
        assertStringIncludes(html, "nested: true");
        // The raw YAML block itself never leaks as a plain box.
        assert(!html.includes('class="front-matter"'));
      });

      await t.step("properties disabled → safe framed fallback", async () => {
        const html = await renderMarkdown("---\ntitle: Doc\n---\nbody", {
          disabled: ["globnotes-properties"],
        });
        assertStringIncludes(html, 'class="front-matter"');
        assertStringIncludes(html, "title: Doc");
      });

      await t.step("mermaid", async () => {
        const html = await renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
        assertStringIncludes(html, '<pre class="mermaid">');
        assertStringIncludes(html, "A--&gt;B");
      });

      await t.step("wikilinks", async () => {
        const { state } = await import("../server/state.ts");
        state.notes.create({ path: "rendering/math", content: "x" });
        const html = await renderMarkdown(
          "see [[rendering/math|Math]] and [[missing note]]",
        );
        // The resolved target renders as a plain link.
        assertStringIncludes(
          html,
          '<a href="/rendering/math">Math</a>',
        );
        // Unresolved wikilinks link the title as written (may be created
        // later) and carry the unresolved class for client-side dimming.
        assertStringIncludes(
          html,
          '<a href="/missing%20note" class="unresolved">',
        );
        assert(!html.includes('href="/rendering/math" class="unresolved"'));
      });

      await t.step("wikilink basename resolution", async () => {
        const { state } = await import("../server/state.ts");
        state.notes.create({ path: "links/wiki-links", content: "x" });
        const html = await renderMarkdown("go to [[wiki-links]]");
        assertStringIncludes(html, '<a href="/links/wiki-links">');
      });

      await t.step("wikilink alias resolution", async () => {
        const { state } = await import("../server/state.ts");
        state.notes.create({
          path: "real/note",
          content: "---\naliases: [Friendly Alias]\n---\nbody",
        });
        const html = await renderMarkdown("see [[Friendly Alias]]");
        assertStringIncludes(html, '<a href="/real/note">');
      });

      await t.step("tag links go to search", async () => {
        const html = await renderMarkdown("filed under #docs");
        assertStringIncludes(
          html,
          '<a href="/_/search?term=%23docs&amp;sortBy=path">#docs</a>',
        );
      });

      await t.step("per-request disabled skips a plugin", async () => {
        const html = await renderMarkdown("a ==b== c", {
          disabled: ["globnotes-mark"],
        });
        assert(!html.includes("<mark>"));
        assertStringIncludes(html, "a ==b== c");
      });

      await t.step("listPlugins returns the internal plugins", () => {
        const list = manager.listPlugins().map((p) => p.id);
        for (
          const id of [
            "globnotes-autolinks",
            "globnotes-callout",
            "globnotes-comments",
            "globnotes-embeds",
            "globnotes-mark",
            "globnotes-mermaid",
          ]
        ) {
          assert(list.includes(id), `missing ${id}`);
        }
      });
    } finally {
      manager.stop();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("render: vault plugin dispatch + plugins.json", async (t) => {
  const vault = await Deno.makeTempDir();
  const pluginDir = path.join(vault, ".globnotes", "plugins", "jsonbox");
  try {
    Deno.mkdirSync(pluginDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(pluginDir, "manifest.json"),
      JSON.stringify({ id: "jsonbox" }),
    );
    Deno.writeTextFileSync(
      path.join(pluginDir, "main.js"),
      `export function getSelectors() {
         return [{ node: "fence", language: "json" }];
       }
       export function parseNode(node) {
         return { parts: ['<div class="jsonbox">' + node.content + '</div>'] };
       }`,
    );
    const manager = new PluginManager(vault, undefined, 1);
    setupState(vault, manager);
    try {
      await t.step("vault plugin renders its selector", async () => {
        const html = await renderMarkdown('```json\n{"a":1}\n```');
        assertStringIncludes(html, '<div class="jsonbox">');
      });

      await t.step("plugins.json disabled drops the plugin", async () => {
        Deno.writeTextFileSync(
          path.join(vault, ".globnotes", "plugins.json"),
          JSON.stringify({ disabled: ["jsonbox"] }),
        );
        manager.stop();
        const manager2 = new PluginManager(vault, undefined, 1);
        setupState(vault, manager2);
        try {
          const html = await renderMarkdown('```json\n{"a":1}\n```');
          assert(!html.includes("jsonbox"));
          assertStringIncludes(html, 'class="language-json"');
        } finally {
          manager2.stop();
        }
      });
    } finally {
      manager.stop();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("render: endpoint end-to-end", async () => {
  const vault = await Deno.makeTempDir();
  let server;
  try {
    server = await bootServer({
      GLOBNOTES_AUTH_TYPE: "none",
      GLOBNOTES_PATH: vault,
      GLOBNOTES_RENDER_WORKERS: "1",
    });
    const create = await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "page",
        content: "# Hi\n\n==marked== and ![[pic.png]]",
      }),
    });
    await create.body?.cancel();

    const res = await fetch(`${server.baseUrl}/_/api/render/page`);
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
    const html = await res.text();
    assertStringIncludes(
      html,
      '<h1 data-source-line="0" data-line="L1" id="hi">',
    );
    assertStringIncludes(html, "<mark>marked</mark>");
    assertStringIncludes(html, '<img src="pic.png"');

    const missing = await fetch(`${server.baseUrl}/_/api/render/nope`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    // Settings endpoints: plugin list + disabled query param.
    const plugins = await fetch(`${server.baseUrl}/_/api/plugins`);
    assertEquals(plugins.status, 200);
    const pluginIds = (await plugins.json()).map((p: { id: string }) => p.id);
    assert(pluginIds.includes("globnotes-mark"));

    const noMark = await fetch(
      `${server.baseUrl}/_/api/render/page?disabled=globnotes-mark`,
    );
    assertEquals(noMark.status, 200);
    assert(!(await noMark.text()).includes("<mark>"));

    const config = await fetch(`${server.baseUrl}/_/api/config`);
    assertEquals((await config.json()).autoEnablePlugins, true);
  } finally {
    await server?.close();
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("render: line numbers gutter option", async () => {
  const multi = "```js\nlet x = 1;\nlet y = 2;\nlet z = 3;\n```";

  // Default: no gutter.
  const off = await renderMarkdown(multi);
  assert(!off.includes("line-numbers-rows"));
  assert(!off.includes("line-numbers"));

  // On: multi-line code blocks gain a line-numbers gutter.
  const on = await renderMarkdown(multi, { lineNumbers: true });
  assertStringIncludes(on, "line-numbers-rows");
  assertStringIncludes(on, 'class="line-numbers language-js"');
  // 3 code lines → exactly 3 empty gutter spans.
  const gutterSpans = (on.match(/<span><\/span>/g) ?? []).length;
  assertEquals(gutterSpans, 3);

  // Single-line code blocks do not get a gutter.
  const single = await renderMarkdown("```js\nlet x = 1;\n```", {
    lineNumbers: true,
  });
  assert(!single.includes("line-numbers-rows"));
});
