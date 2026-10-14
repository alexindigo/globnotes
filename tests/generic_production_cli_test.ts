// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("production acceptance CLI: help and malformed flags cannot start fixtures", async () => {
  const entry = new URL(
    "../client/tests/e2e/generic-plugin-system.mjs",
    import.meta.url,
  );
  for (
    const [args, code] of [
      [["--help"], 0],
      [["--unknown"], 2],
      [["--include-dev"], 2],
      [["--artifacts"], 2],
      [["--artifacts", "--help"], 2],
      [["--help", "--help"], 2],
      [["--artifacts", "/one", "--artifacts", "/two"], 2],
    ] as [string[], number][]
  ) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        "--deny-read",
        "--deny-write",
        "--deny-net",
        "--deny-run",
        "--deny-env",
        "--deny-sys",
        entry.href,
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, code, JSON.stringify(args));
    const text = new TextDecoder().decode(
      code === 0 ? result.stdout : result.stderr,
    );
    if (code === 0) {
      assertStringIncludes(text, "Usage: generic-plugin-system");
    } else {
      assert(
        /Unknown argument|Duplicate argument|requires a directory/.test(text),
        text,
      );
    }
  }
});
