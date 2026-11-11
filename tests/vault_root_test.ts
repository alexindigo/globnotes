import { testMetadata } from "./helpers/environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "./helpers/config.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { VaultHub } from "../server/hub/hub.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { bootServer } from "./helpers/boot.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

Deno.test("vault root: configured spellings share one absolute normalized path", async (t) => {
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
      await t.step(spelling, async (t) => {
        const config = new GlobalConfig(
          testEnvironment({ GLOBNOTES_GLOBNOTES_PATH: spelling }),
        );
        await t.step(
          "config owns normalization",
          () => assertEquals(config.notesPath, vault),
        );
        await t.step("direct storage inventory", () =>
          assertEquals(
            new FileSystemNotes(spelling).listAllNoteFilenames().sort(),
            ["readme.md", "sub/child.md"],
          ));
        await t.step("hub inventories the same coordinates", () => {
          const hub = new VaultHub(
            config.notesPath,
            testMetadata(config.statePath),
            undefined,
          );
          try {
            assertEquals(hub.scanNow().files, 2);
            assertEquals(hub.fileState("readme.md")?.diskPath, "readme.md");
            assertEquals(
              hub.fileState("sub/child.md")?.diskPath,
              "sub/child.md",
            );
            assertEquals(
              hub.relativePath(path.join(config.notesPath, "sub/child.md")),
              "sub/child.md",
            );
          } finally {
            hub.stop();
          }
        });
      });
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("vault root: dot-dot spelling preserves initial search and hub-projected changes", async () => {
  const vault = await Deno.makeTempDir({ prefix: "globnotes-root-http-" });
  try {
    await Deno.mkdir(`${vault}/sub`);
    await Deno.writeTextFile(`${vault}/readme.md`, "rootneedle");
    await Deno.writeTextFile(`${vault}/sub/child.md`, "rootneedle");
    const server = await bootServer({
      GLOBNOTES_GLOBNOTES_PATH: `${vault}/sub/../`,
      fixtureAuth: { auth_type: "none" },
      GLOBNOTES__HUB_SCANINTERVAL: "0.1",
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
      await Deno.writeTextFile(`${vault}/sub/child.md`, "externalneedle");
      await waitUntil(async (signal) => {
        const rows = await (await fetch(
          `${server.baseUrl}/_/api/search?term=externalneedle`,
          { signal },
        )).json();
        return rows.length === 1 && rows[0].path === "sub/child"
          ? done()
          : pending(rows);
      }, { label: "hub change reaches search through normalized root" });
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
