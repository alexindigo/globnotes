// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { browserChange } from "../server/hub/browser_changes.ts";
import { OperationError } from "../server/plugins/errors.ts";

const NAMES = ["question?.bin", "colon:.bin", "star*.bin"];
const bytes = new TextEncoder().encode("attachment bytes");
const encodedPath = (p: string) =>
  p.split("/").map(encodeURIComponent).join("/");

Deno.test("attachment names: existing special names download through API and vault routes", async (t) => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    for (const name of NAMES) {
      await Deno.writeFile(`${server.vault}/${name}`, bytes);
      for (const route of ["/_/api/files/", "/"]) {
        await t.step(route + name, async () => {
          const response = await fetch(
            server.baseUrl + route + encodedPath(name),
          );
          const body = new Uint8Array(await response.arrayBuffer());
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

Deno.test("attachment names: raw and encoded references survive base-aware note moves and relinks", async (t) => {
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
          const content = NAMES.map((name) =>
            `[file](assets/${
              encoding === "encoded" ? encodeURIComponent(name) : name
            })`
          ).join("\n");
          const created = await fetch(`${server.baseUrl}/_/api/notes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: source + "/note", content }),
          });
          const original = await created.json();
          assertEquals(created.status, 200);
          const preview = await (await fetch(
            `${server.baseUrl}/_/api/rename-preview?path=${source}/note&new_path=${target}/note`,
          )).json();
          const response = await fetch(
            `${server.baseUrl}/_/api/notes/${source}/note?file_refs=${strategy}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                newPath: target + "/note",
                base: { kind: "version", version: original.version },
              }),
            },
          );
          const note = await response.json();
          assertEquals(response.status, 200, JSON.stringify(note));
          assertEquals(
            preview.map((r: { path: string }) => r.path).sort(),
            NAMES.map((name) => `${source}/assets/${name}`).sort(),
          );
          assertEquals(
            note.movedFiles.length,
            strategy === "move" ? NAMES.length : 0,
          );
          const owner = strategy === "move" ? target : source;
          for (const name of NAMES) {
            const url = `${
              strategy === "move" ? "assets/" : `../${source}/assets/`
            }${encodeURIComponent(name)}`;
            assert(note.content.includes(`[file](${url})`), note.content);
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
            const body = new Uint8Array(await downloaded.arrayBuffer());
            assertEquals(downloaded.status, 200);
            assertEquals(body, bytes);
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

Deno.test("attachment names: one decoded identity drives gated moves, projections and global rewrites", async () => {
  const f = hubOperationsFixture();
  try {
    Deno.mkdirSync(`${f.vault}/old/assets`, { recursive: true });
    Deno.mkdirSync(`${f.vault}/new/assets`, { recursive: true });
    for (const name of ["what?.bin", "literal%3F.bin", ".hidden?.bin"]) {
      Deno.writeFileSync(`${f.vault}/old/assets/${name}`, bytes);
    }
    Deno.writeFileSync(`${f.root}/escape?.bin`, bytes);
    Deno.symlinkSync(
      `${f.root}/escape?.bin`,
      `${f.vault}/old/assets/escape?.bin`,
    );
    Deno.writeTextFileSync(`${f.vault}/new/assets/what?.bin`, "taken");
    const content =
      '[file](assets/what%3f.bin)\n<img src="assets/literal%253F.bin">\n' +
      "[hidden](assets/.hidden%3F.bin)\n[escape](assets/escape%3F.bin)\n[traversal](../../../escape%3F.bin)\n" +
      "[web](https://example.test/what%3F.bin)\n[invalid](assets/%broken)";
    f.hub.scanNow();
    const original = await f.operations.createNote({
      path: "old/note",
      content,
    }, f.api());
    for (
      const data of [{ newPath: "new/note" }, {
        newPath: "new/note",
        base: { kind: "version" as const, version: "0".repeat(64) },
      }]
    ) {
      const error = await assertRejects(
        () => f.operations.updateNote("old/note", data, "move", f.api()),
        OperationError,
      );
      assertEquals(error.code, "base" in data ? "base_stale" : "base_required");
      assertEquals(Deno.readFileSync(`${f.vault}/old/assets/what?.bin`), bytes);
      assertEquals(Deno.readTextFileSync(`${f.vault}/old/note.md`), content);
    }
    const moved = await f.operations.updateNote(
      "old/note",
      {
        newPath: "new/note",
        base: { kind: "version", version: original.version! },
      },
      "move",
      f.api(),
    );
    assertEquals(moved.movedFiles.map((file) => file.newPath).sort(), [
      "new/assets/literal%3F.bin",
      "new/assets/what? 1.bin",
    ]);
    assert(
      moved.content!.includes("[file](assets/what%3F%201.bin)"),
      moved.content!,
    );
    assert(moved.content!.includes('<img src="assets/literal%253F.bin">'));
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/new/assets/what?.bin`),
      "taken",
    );
    assertEquals(
      Deno.readFileSync(`${f.vault}/new/assets/literal%3F.bin`),
      bytes,
    );
    assertEquals(Deno.readFileSync(`${f.root}/escape?.bin`), bytes);
    assert(Deno.lstatSync(`${f.vault}/old/assets/escape?.bin`).isSymlink);
    const batch = f.batches.at(-1)!;
    for (
      const name of [
        "new/assets/literal%3F.bin",
        "new/assets/what? 1.bin",
        "new/note.md",
      ]
    ) {
      const entry = batch.find((entry) => entry.path === name)!;
      assert(entry, name);
      assertEquals(entry.peer, "globnotes");
      assertEquals(entry.origin, "api");
      assertEquals(f.hub.fileState(name)?.hash, entry.afterHash);
      assertEquals(
        browserChange(entry, f.hub.root, f.config.statePath)?.path,
        name,
      );
    }
    const beforeScan = f.batches.length;
    f.hub.scanNow();
    assertEquals(
      f.batches.length,
      beforeScan,
      "managed moves never echo as local",
    );
    Deno.renameSync(
      `${f.vault}/new/assets/literal%3F.bin`,
      `${f.vault}/new/assets/renamed?.bin`,
    );
    await f.operations.rewriteRefs(
      "new/assets/literal%3F.bin",
      "new/assets/renamed?.bin",
      f.api(),
    );
    assert(
      f.notes.get("new/note").content!.includes(
        '<img src="assets/renamed%3F.bin">',
      ),
    );
    assertEquals(f.batches.at(-1)![0].peer, "globnotes");
    for (
      const [name, code] of [[".hidden?.bin", 404], [
        "escape?.bin",
        400,
      ]] as const
    ) {
      const response = browserChange(
        { ...batch[0], path: "old/assets/" + name, oldPath: null },
        f.hub.root,
        f.config.statePath,
      );
      assertEquals(response, null, `excluded file ${code}`);
    }
  } finally {
    f.close();
  }
});
