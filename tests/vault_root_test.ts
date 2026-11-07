// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "../server/config.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { bootServer } from "./helpers/boot.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

Deno.test("vault root: configured spellings share one absolute normalized path", async () => {
  const vault = await Deno.makeTempDir({ prefix: "globnotes-root-" });
  try {
    await Deno.mkdir(`${vault}/sub`);
    await Deno.writeTextFile(`${vault}/readme.md`, "rootneedle");
    await Deno.writeTextFile(`${vault}/sub/child.md`, "rootneedle");
    for (
      const spelling of [
        `${vault}/sub/../`,
        `${vault}//./`,
        path.relative(Deno.cwd(), vault) + "/./",
      ]
    ) {
      const config = new GlobalConfig(
        testEnvironment({ GLOBNOTES_PATH: spelling }),
      );
      assertEquals(config.notesPath, vault, spelling);
      const notes = new FileSystemNotes(config.notesPath);
      assertEquals(notes.listAllNoteFilenames().sort(), [
        "readme.md",
        "sub/child.md",
      ]);
      // The storage API also computes relative names structurally, without
      // assuming its caller passed a string of the same length as join().
      assertEquals(
        new FileSystemNotes(spelling).listAllNoteFilenames().sort(),
        ["readme.md", "sub/child.md"],
      );
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("vault root: dot-dot spelling preserves the initial search inventory", async () => {
  const vault = await Deno.makeTempDir({ prefix: "globnotes-root-http-" });
  try {
    await Deno.mkdir(`${vault}/sub`);
    await Deno.writeTextFile(`${vault}/readme.md`, "rootneedle");
    await Deno.writeTextFile(`${vault}/sub/child.md`, "rootneedle");
    const server = await bootServer({
      GLOBNOTES_PATH: `${vault}/sub/../`,
      GLOBNOTES_AUTH_TYPE: "none",
    });
    try {
      const status = await waitUntil(async (signal) => {
        const s = await (await fetch(`${server.baseUrl}/_/api/index-status`, {
          signal,
        })).json();
        return s.initial || s.syncing ? pending(s) : done(s);
      }, { label: "normalized-root initial index" });
      assertEquals(status.done, 2);
      assertEquals(status.total, 2);
      const response = await fetch(
        `${server.baseUrl}/_/api/search?term=rootneedle`,
      );
      assertEquals(response.status, 200);
      const results = await response.json();
      assertEquals(results.map((r: { path: string }) => r.path).sort(), [
        "readme",
        "sub/child",
      ]);
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
