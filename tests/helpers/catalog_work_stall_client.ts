// SPDX-License-Identifier: LGPL-3.0-only
/** Run the unmodified native backup consumer, substituting only its server entry
 * with the test-owned scheduling seam. Works against an exact main export too. */
import { waitForAudit } from "./catalog_work_audit.ts";
import { fromFileUrl } from "@std/path";
import {
  publishRecord,
  readRecord,
  watchOwnerPipe,
} from "./process_records.ts";
const directory = Deno.args[0];
const NativeCommand = Deno.Command;
const coordinator = watchOwnerPipe(Deno.stdin.readable, "coordinator");
type WrappedOwner = { child: Deno.ChildProcess; exited: boolean };
const servers: WrappedOwner[] = [];
let finished = false,
  coordinatorExited = false;
coordinator.exit.then(() => {
  coordinatorExited = true;
  if (!finished) { for (const owner of servers) stop(owner); }
});
function stop(owner: WrappedOwner) {
  if (owner.exited) return;
  try {
    Deno.kill(owner.child.pid, "SIGCONT");
    owner.child.kill("SIGKILL");
  } catch { /* exited */ }
}
Deno.Command = class extends NativeCommand {
  #wrapped = false;
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
        fromFileUrl(new URL("./catalog_work_stall_server.ts", import.meta.url)),
      );
      options = {
        ...options,
        args,
        stdin: "piped",
        env: {
          ...options.env,
          WORK_PROOF_DIR: directory,
          WORK_PROOF_EXIT_BEFORE_RECORD:
            Deno.env.get("WORK_PROOF_EXIT_BEFORE_RECORD") ?? "0",
        },
      };
    }
    super(command, options);
    this.#wrapped = main !== -1;
  }
  override spawn() {
    if (coordinatorExited) {
      throw Error("coordinator exited before wrapped server spawn");
    }
    const child = super.spawn();
    if (this.#wrapped) {
      const owner = { child, exited: false };
      servers.push(owner);
      publishRecord(
        `${directory}/server-owner.json`,
        JSON.stringify({ pid: child.pid }),
      );
      child.status.then((status) => {
        owner.exited = true;
        publishRecord(
          `${directory}/server-exit.json`,
          JSON.stringify({ pid: child.pid, code: status.code }),
        );
      }).catch((error) =>
        console.error("server exit publication failed", error)
      );
    }
    return child;
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
    if (!readRecord(`${directory}/before-stop.json`)) throw error;
  } catch (missing) {
    if (missing instanceof Deno.errors.NotFound) throw error;
    throw missing;
  }
  // Preserve the first native failure, but keep this owner alive until the
  // original server invocation has been audited. CLI shutdown closes/kills its
  // owned subprocesses, which would otherwise destroy the red-run outcome.
  publishRecord(
    `${directory}/first-native-error.json`,
    JSON.stringify({ detail: String(error) }),
  );
  try {
    await waitForAudit(directory, "completed", [
      coordinator,
      ...servers.map((owner) => ({
        label: "wrapped server",
        exit: owner.child.status,
      })),
    ]);
  } catch (auditError) {
    throw new AggregateError(
      [error, auditError],
      "Native consumer and invocation audit failed",
    );
  }
  throw error;
} finally {
  finished = true;
  Deno.Command = NativeCommand;
  try {
    for (const owner of servers) stop(owner);
    for (const owner of servers) {
      await owner.child.status;
      try {
        await owner.child.stdin.close();
      } catch { /* pipe already closed */ }
    }
  } finally {
    await coordinator.dispose();
  }
}
