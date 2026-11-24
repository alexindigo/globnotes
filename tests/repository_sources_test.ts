// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { copyRepositorySources } from "./helpers/repository_sources.ts";

async function withSourceFixture(
  tracked: string[],
  use: (
    fixture: { root: string; inventory: string; directory: string },
  ) => Promise<void>,
) {
  const directory = await Deno.makeTempDir({ prefix: "repository-sources-" });
  try {
    const root = join(directory, "repo"),
      inventory = join(directory, "files.z");
    await Deno.writeTextFile(inventory, tracked.join("\0") + "\0");
    for (const relative of tracked) {
      const file = join(root, relative);
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeTextFile(file, relative);
    }
    await use({ root, inventory, directory });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function readCopy(directory: string, prefix = ""): Promise<unknown[]> {
  const files = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory) files.push(...await readCopy(path, `${name}/`));
    else files.push([name, await Deno.readTextFile(path)]);
  }
  return files.sort();
}

Deno.test("unit source copies exclude both live tool files and out-of-profile tracked files", async () => {
  const expected = [
    "client/test.vue",
    "deno.json",
    "deno.lock",
    "shared/with space\nand newline.ts",
    "tailwind.config.js",
    "vitest.config.mjs",
  ];
  await withSourceFixture(
    [...expected, "client/tests/e2e/driver.mjs", "server/main.ts"],
    async ({ root, inventory, directory }) => {
      const transient = join(root, "client/vite.config.js.timestamp-demo.js");
      await Deno.writeTextFile(transient, "tool output");
      const edited = join(root, "client/test.vue");
      await Deno.writeTextFile(edited, "current edited bytes");
      const first = join(directory, "first"),
        second = join(directory, "second");
      await copyRepositorySources("unit-control", first, { root, inventory });
      await Deno.remove(transient);
      await copyRepositorySources("unit-control", second, { root, inventory });
      const wanted = expected.map((path) => [
        path,
        path === "client/test.vue" ? "current edited bytes" : path,
      ]);
      assertEquals([await readCopy(first), await readCopy(second)], [
        wanted,
        wanted,
      ]);
    },
  );
});

Deno.test("plugin source copies strip only the declared prefix and fail on missing tracked inputs", async () => {
  const prefix = "plugins/globnotes-backup/";
  const expected = ["endpoints/status/get.js", "manifest.json"];
  await withSourceFixture(
    [...expected.map((path) => prefix + path), "plugins/other/manifest.json"],
    async ({ root, inventory, directory }) => {
      const first = join(directory, "first"),
        second = join(directory, "second");
      await copyRepositorySources("backup-plugin", first, { root, inventory });
      assertEquals(
        await readCopy(first),
        expected.map((path) => [path, prefix + path]),
      );
      const missing = join(root, prefix, expected[0]);
      await Deno.remove(missing);
      await assertRejects(
        () =>
          copyRepositorySources("backup-plugin", second, { root, inventory }),
        Deno.errors.NotFound,
        missing,
      );
    },
  );
});
