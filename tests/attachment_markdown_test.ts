// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

Deno.test("attachment Markdown: rewritten destinations render and resolve after repeated moves and relinks", async (t) => {
  const server = await bootServer({ fixtureAuth: { auth_type: "none" } });
  // Explicit URL fixtures also catch accidental double decoding of literal %29.
  const files = [
    ["a(1).png", "a%281%29.png"],
    ["b).png", "b%29.png"],
    ["c(.png", "c%28.png"],
    ["angle<> space.png", "angle%3C%3E%20space.png"],
    ["literal%29.png", "literal%2529.png"],
    ["punct!'*.png", "punct!'*.png"],
    ['quote"&#+?.png', "quote%22%26%23%2B%3F.png"],
    ["caf\u00e9.png", "caf%C3%A9.png"],
  ];
  const bytes = new TextEncoder().encode("attachment bytes");
  const jsonHeaders = { "content-type": "application/json" };
  const api = server.baseUrl + "/_/api/";
  async function checkRendered(
    content: string,
    notePath: string,
    urls: string[],
  ) {
    const rendered = await fetch(api + "render", {
      method: "POST",
      headers: { "content-type": "text/markdown" },
      body: content,
    });
    const html = await rendered.text();
    assertEquals(rendered.status, 200, html);
    const hrefs = Array.from(html.matchAll(/<a href="([^"]+)"/g), (m) => m[1]);
    assertEquals(hrefs, urls, html);
    for (const href of hrefs) {
      const response = await fetch(
        new URL(href, `${server.baseUrl}/${notePath}.md`),
      );
      const actual = new Uint8Array(await response.arrayBuffer());
      assertEquals(response.status, 200, href);
      assertEquals(actual, bytes, href);
    }
  }
  try {
    for (const strategy of ["move", "relink"]) {
      await t.step(strategy, async () => {
        const source = strategy + "-source";
        const names = files.map(([name]) => name);
        const encoded = files.map(([, url]) => url);
        await Deno.mkdir(`${server.vault}/${source}/assets`, {
          recursive: true,
        });
        for (const name of names) {
          await Deno.writeFile(
            `${server.vault}/${source}/assets/${name}`,
            bytes,
          );
        }
        const created = await fetch(api + "notes", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            path: `${source}/note`,
            content: encoded.map((url, i) => `[file${i}](assets/${url})`).join(
              "\n",
            ),
          }),
        });
        let note = await created.json();
        assertEquals(created.status, 200, JSON.stringify(note));
        let current = `${source}/note`;
        for (const target of [`${strategy}-new/note`, `${strategy}-root`]) {
          const preview = await fetch(
            api + "rename-preview?" +
              new URLSearchParams({ path: current, new_path: target }),
          );
          const refs = await preview.json();
          assertEquals(preview.status, 200, JSON.stringify(refs));
          const oldOwner = strategy === "move"
            ? current.slice(0, current.lastIndexOf("/"))
            : source;
          assertEquals(
            refs.map((ref: { path: string }) => ref.path).sort(),
            names.map((name) => `${oldOwner}/assets/${name}`).sort(),
          );
          const moved = await fetch(
            api + `notes/${current}?file_refs=${strategy}`,
            {
              method: "PATCH",
              headers: jsonHeaders,
              body: JSON.stringify({
                newPath: target,
                ...(note.version
                  ? { base: { kind: "version", version: note.version } }
                  : {}),
              }),
            },
          );
          note = await moved.json();
          assertEquals(moved.status, 200, JSON.stringify(note));
          const owner = strategy === "move"
            ? target.split("/").slice(0, -1).join("/")
            : source;
          const prefix = target.includes("/")
            ? (strategy === "move" ? "assets/" : `../${source}/assets/`)
            : `/${owner ? owner + "/" : ""}assets/`;
          await checkRendered(
            note.content,
            target,
            encoded.map((url) => prefix + url),
          );
          assertEquals(
            await Deno.readTextFile(`${server.vault}/${target}.md`),
            note.content,
          );
          current = target;
        }
        const owner = strategy === "move" ? "" : source + "/";
        const oldPath = owner + "assets/b).png",
          newPath = owner + "assets/renamed(.png";
        await Deno.rename(
          `${server.vault}/${oldPath}`,
          `${server.vault}/${newPath}`,
        );
        const rewritten = await fetch(
          api + "files/rewrite-refs?" +
            new URLSearchParams({ old_path: oldPath, new_path: newPath }),
          { method: "POST" },
        );
        await rewritten.body?.cancel();
        assertEquals(rewritten.status, 200);
        const saved = await (await fetch(api + `notes/${current}`)).json();
        encoded[1] = "renamed%28.png";
        await checkRendered(
          saved.content,
          current,
          encoded.map((url) => `/${owner}assets/${url}`),
        );
      });
    }
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});
