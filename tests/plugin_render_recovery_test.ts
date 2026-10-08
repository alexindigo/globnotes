// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";

for (const kind of ["missing-source", "constructor"]) {
  Deno.test(`review repairs: R03 actual ${kind} respawn failure preserves host process and unrelated renderer`, async () => {
    const evidence = await Deno.makeTempDir({ prefix: `review-r03-${kind}-` });
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${new URL("../deno.json", import.meta.url).pathname}`,
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        new URL("./helpers/render_recovery_child.ts", import.meta.url).pathname,
        kind,
        evidence,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill("SIGTERM");
    }, 8000);
    try {
      const output = await child.output();
      const stdout = new TextDecoder().decode(output.stdout),
        stderr = new TextDecoder().decode(output.stderr);
      await Deno.writeTextFile(`${evidence}/stdout.log`, stdout);
      await Deno.writeTextFile(`${evidence}/stderr.log`, stderr);
      await Deno.writeTextFile(
        `${evidence}/child-exit.json`,
        JSON.stringify({ code: output.code, expired }),
      );
      const before = JSON.parse(
        await Deno.readTextFile(`${evidence}/before-fault.json`),
      );
      assertEquals(before.kind, kind);
      assertEquals(before.victimGenerations.length, 2);
      console.log(
        JSON.stringify({
          kind,
          childExit: output.code,
          expired,
          evidence,
          stdout,
          stderr,
        }),
      );
      assertEquals(
        expired,
        false,
        "child deadline is not a defect reproduction",
      );
      assertEquals(output.code, 0, stderr);
      const after = JSON.parse(
        await Deno.readTextFile(`${evidence}/after-fault.json`),
      );
      assert(
        after.hostProcessAlive && after.failedWorkSettled &&
          after.affectedUnavailable,
      );
      assertEquals(after.unaffectedGenerations, before.unaffectedGenerations);
      assertEquals(after.unrelatedOutput.parts, ["<b>unrelated consumer</b>"]);
      if (kind === "constructor") assert(after.actualConstructorRefusals > 0);
    } finally {
      clearTimeout(timer);
      console.log(JSON.stringify({ retainedR03Evidence: evidence }));
    }
  });
}
