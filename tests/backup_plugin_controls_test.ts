// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
for (
  const kind of [
    "count",
    "order",
    "location",
    "preimage",
    "pin",
    "recovery",
    "aliases",
  ]
) {
  Deno.test(`backup controls: actual ${kind} producer is rejected by its named disk/recovery consumer`, async () => {
    const root = await Deno.makeTempDir({
      prefix: `globnotes-backup-controls-${kind}-`,
    });
    const before = await Deno.readFile(
      new URL("../plugins/globnotes-backup/backup.js", import.meta.url),
    );
    for (const mode of ["healthy", "broken"]) {
      const directory = `${root}/${mode}`;
      await Deno.mkdir(directory);
      const argv = [
        "run",
        "--quiet",
        "--cached-only",
        "--frozen",
        "--config=deno.json",
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        "tests/helpers/backup_control_child.ts",
        kind,
        mode,
        directory,
      ];
      const child = new Deno.Command(Deno.execPath(), {
        args: argv,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 60_000);
      const output = await child.output();
      clearTimeout(timer);
      await Deno.writeFile(`${directory}/stdout.log`, output.stdout);
      await Deno.writeFile(`${directory}/stderr.log`, output.stderr);
      await Deno.writeTextFile(
        `${directory}/result.json`,
        JSON.stringify({
          argv,
          code: output.code,
          timedOut,
          healthy: mode === "healthy",
          namedConsumer: `BACKUP_CONSUMER_${kind}`,
        }),
      );
      assert(
        !timedOut,
        "control timed out rather than reaching named consumer",
      );
      if (mode === "healthy") {
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
      } else {
        assert(output.code !== 0);
        assert(
          new TextDecoder().decode(output.stderr).includes(
            `BACKUP_CONSUMER_${kind}`,
          ),
          "broken producer failed outside intended real consumer",
        );
      }
    }
    assertEquals(
      await Deno.readFile(
        new URL("../plugins/globnotes-backup/backup.js", import.meta.url),
      ),
      before,
    );
    console.log(JSON.stringify({ retainedBackupControls: root }));
  });
}
