// SPDX-License-Identifier: LGPL-3.0-only
/** Run the unmodified native backup consumer, substituting only its server entry
 * with the test-owned scheduling seam. Works against an exact main export too. */
const directory = Deno.args[0];
const NativeCommand = Deno.Command;
Deno.Command = class extends NativeCommand {
  constructor(command: string | URL, options: Deno.CommandOptions = {}) {
    const args = [...options.args ?? []];
    const main = args.findIndex((argument) =>
      argument.endsWith("/server/main.ts")
    );
    if (main !== -1) {
      args.splice(
        main,
        1,
        "--allow-run",
        new URL("./catalog_work_stall_server.ts", import.meta.url).pathname,
      );
      options = {
        ...options,
        args,
        env: { ...options.env, WORK_PROOF_DIR: directory },
      };
    }
    super(command, options);
  }
};
Deno.args.splice(
  0,
  Deno.args.length,
  "--variant",
  "count-9",
  "--artifacts",
  `${directory}/native`,
);
try {
  await import("../../client/tests/e2e/backup-plugin.mjs");
} catch (error) {
  // A setup failure before the scheduling seam has no captured invocation to
  // preserve; propagate it rather than waiting for an outcome that cannot exist.
  try {
    Deno.statSync(`${directory}/before-stop.json`);
  } catch (missing) {
    if (missing instanceof Deno.errors.NotFound) throw error;
    throw missing;
  }
  // Preserve the first native failure, but keep this owner alive until the
  // original server invocation has been audited. CLI shutdown closes/kills its
  // owned subprocesses, which would otherwise destroy the red-run outcome.
  Deno.writeTextFileSync(
    `${directory}/first-native-error.json`,
    JSON.stringify({ detail: String(error) }),
  );
  const watcher = Deno.watchFs(directory);
  try {
    const completed = () => {
      for (const name of ["completed", "invocation-error"]) {
        try {
          Deno.statSync(`${directory}/${name}.json`);
          return true;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      return false;
    };
    if (!completed()) {
      for await (const _event of watcher) if (completed()) break;
    }
  } finally {
    watcher.close();
  }
  throw error;
}
