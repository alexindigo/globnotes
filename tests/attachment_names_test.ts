// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

const NAMES = ["question?.bin", "colon:.bin", "star*.bin"];
const bytes = new TextEncoder().encode("attachment bytes");
const encodedPath = (p: string) =>
  p.split("/").map(encodeURIComponent).join("/");

Deno.test("attachment names: decode once for HTML and rewrites without admitting hidden or escaped files", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  const outside = await Deno.makeTempDir({
    prefix: "globnotes-attachment-outside-",
  });
  const api = (p: string, body?: unknown) =>
    fetch(
      `${server.baseUrl}/_/api/${p}`,
      body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  try {
    await Deno.mkdir(`${server.vault}/old/assets`, { recursive: true });
    for (const name of ["what?.bin", "literal%3F.bin", ".hidden?.bin"]) {
      await Deno.writeFile(`${server.vault}/old/assets/${name}`, bytes);
    }
    await Deno.writeFile(`${outside}/escape?.bin`, bytes);
    await Deno.symlink(
      `${outside}/escape?.bin`,
      `${server.vault}/old/assets/escape?.bin`,
    );
    const content =
      '[file](assets/what%3f.bin)\n<img src="assets/literal%253F.bin">\n' +
      "[hidden](assets/.hidden%3F.bin)\n[escape](assets/escape%3F.bin)\n[traversal](../../../escape%3F.bin)\n" +
      "[web](https://example.test/what%3F.bin)\n[invalid](assets/%broken)";
    const created = await api("notes", { path: "old/note", content });
    await created.body?.cancel();
    assertEquals(created.status, 200);
    for (
      const [name, status] of [[".hidden?.bin", 404], [
        "escape?.bin",
        400,
      ]] as const
    ) {
      const response = await api("files/old/assets/" + encodedPath(name));
      await response.body?.cancel();
      assertEquals(response.status, status);
    }
    const moved = await fetch(
      `${server.baseUrl}/_/api/notes/old/note?file_refs=move`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPath: "new/note" }),
      },
    );
    const note = await moved.json();
    assertEquals(moved.status, 200);
    assertEquals(
      note.movedFiles.map((f: { newPath: string }) => f.newPath).sort(),
      ["new/assets/literal%3F.bin", "new/assets/what?.bin"],
    );
    assert(note.content.includes('<img src="assets/literal%253F.bin">'));
    assert(note.content.includes("[file](assets/what%3F.bin)"));
    assertEquals(
      await Deno.readFile(`${server.vault}/new/assets/literal%3F.bin`),
      bytes,
    );
    assertEquals(await Deno.readFile(`${outside}/escape?.bin`), bytes);
    assert(
      (await Deno.lstat(`${server.vault}/old/assets/escape?.bin`)).isSymlink,
    );

    // The global rewrite path must compare decoded filenames too, even when
    // the original target vanished and its raw filename is absent in the URL.
    await Deno.rename(
      `${server.vault}/new/assets/literal%3F.bin`,
      `${server.vault}/new/assets/renamed?.bin`,
    );
    const query = new URLSearchParams({
      old_path: "new/assets/literal%3F.bin",
      new_path: "new/assets/renamed?.bin",
    });
    const rewritten = await api("files/rewrite-refs?" + query, {});
    await rewritten.body?.cancel();
    assertEquals(rewritten.status, 200);
    const saved = await (await api("notes/new/note")).json();
    assert(
      saved.content.includes('<img src="assets/renamed%3F.bin">'),
      saved.content,
    );
    assertEquals(
      await Deno.readTextFile(`${server.vault}/new/note.md`),
      saved.content,
    );
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("attachment names: existing special names download through API and vault routes", async (t) => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    for (const name of NAMES) {
      await Deno.writeFile(`${server.vault}/${name}`, bytes);
      for (const route of ["/_/api/files/", "/"]) {
        await t.step(route + name, async () => {
          const url = server.baseUrl + route + encodedPath(name);
          const response = await fetch(url);
          const body = new Uint8Array(await response.arrayBuffer());
          console.log(
            JSON.stringify({ request: url, status: response.status }),
          );
          assertEquals(response.status, 200);
          assertEquals(body, bytes);
          assertEquals(
            response.headers.get("content-disposition"),
            `attachment; filename="${name}"`,
          );
        });
      }
    }
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("attachment names: raw and URL-encoded references survive note moves and relinks", async (t) => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    for (const encoding of ["raw", "encoded"]) {
      for (const strategy of ["move", "relink"]) {
        await t.step(`${encoding} ${strategy}`, async () => {
          const source = `${encoding}-${strategy}`, target = source + "-new";
          await Deno.mkdir(`${server.vault}/${source}/assets`, {
            recursive: true,
          });
          for (const name of NAMES) {
            await Deno.writeFile(
              `${server.vault}/${source}/assets/${name}`,
              bytes,
            );
          }
          const urls = NAMES.map((name) =>
            "assets/" +
            (encoding === "encoded" ? encodeURIComponent(name) : name)
          );
          const content = urls.map((url) => `[file](${url})`).join("\n");
          const create = await fetch(`${server.baseUrl}/_/api/notes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: source + "/note", content }),
          });
          await create.body?.cancel();
          assertEquals(create.status, 200);
          const preview = await (await fetch(
            `${server.baseUrl}/_/api/rename-preview?path=${source}/note&new_path=${target}/note`,
          )).json();
          const response = await fetch(
            `${server.baseUrl}/_/api/notes/${source}/note?file_refs=${strategy}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ newPath: target + "/note" }),
            },
          );
          const note = await response.json();
          console.log(
            JSON.stringify({
              encoding,
              strategy,
              preview,
              status: response.status,
              note,
            }),
          );
          assertEquals(response.status, 200);
          const owner = strategy === "move" ? target : source;
          assertEquals(
            note.movedFiles.length,
            strategy === "move" ? NAMES.length : 0,
          );
          assertEquals(
            preview.map((r: { path: string }) => r.path).sort(),
            NAMES.map((name) => `${source}/assets/${name}`).sort(),
          );
          for (const name of NAMES) {
            const expectedUrl = `${
              strategy === "move" ? "assets/" : `../${source}/assets/`
            }${encodeURIComponent(name)}`;
            assert(
              note.content.includes(`[file](${expectedUrl})`),
              note.content,
            );
            assertEquals(
              await Deno.readFile(`${server.vault}/${owner}/assets/${name}`),
              bytes,
            );
            if (strategy === "move") {
              await assertRejects(
                () => Deno.stat(`${server.vault}/${source}/assets/${name}`),
                Deno.errors.NotFound,
              );
            }
            const downloaded = await fetch(
              `${server.baseUrl}/${encodedPath(owner + "/assets/" + name)}`,
            );
            const actual = new Uint8Array(await downloaded.arrayBuffer());
            assertEquals(downloaded.status, 200);
            assertEquals(actual, bytes);
          }
          assertEquals(
            await Deno.readTextFile(`${server.vault}/${target}/note.md`),
            note.content,
          );
        });
      }
    }
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});
