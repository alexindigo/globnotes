// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";

const SCRIPT = new URL("../scripts/check-release-version.sh", import.meta.url);

/** Runs a copy of the script beside a temporary VERSION file. */
async function check(
  version: string,
  tag: string,
): Promise<{ code: number; output: string }> {
  const root = await Deno.makeTempDir({ prefix: "globnotes-release-" });
  try {
    await Deno.mkdir(`${root}/scripts`);
    await Deno.copyFile(SCRIPT, `${root}/scripts/check-release-version.sh`);
    await Deno.writeTextFile(`${root}/VERSION`, version);
    const result = await new Deno.Command("bash", {
      args: [`${root}/scripts/check-release-version.sh`, tag],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
      code: result.code,
      output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("a tag equal to v + VERSION passes", async () => {
  assertEquals((await check("2.3.2\n", "v2.3.2")).code, 0);
});

Deno.test("a mismatched tag fails and names both values", async () => {
  const result = await check("2.3.2\n", "v2.3.3");
  assertEquals(result.code, 1);
  assert(
    result.output.includes("v2.3.3") && result.output.includes("2.3.2"),
    result.output,
  );
});

Deno.test("a tag without the v prefix fails", async () => {
  assertEquals((await check("2.3.2\n", "2.3.2")).code, 1);
});
