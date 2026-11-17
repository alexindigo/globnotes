// SPDX-License-Identifier: LGPL-3.0-only
/** Test-only entry wrapping the real server. Pause before the final capture's
 * first staging cleanup, before its filesystem deadline is installed. */
import { PluginHost } from "../../server/plugins/host.ts";
import { AuxiliaryFilesystem } from "../../server/plugins/auxiliary_fs.ts";
import { processClock } from "../../server/observed_time.ts";
import { auditInvocation } from "./catalog_work_audit.ts";

const directory = Deno.env.get("WORK_PROOF_DIR")!;
const vault = Deno.env.get("GLOBNOTES_GLOBNOTES_PATH")!;
const invoke = PluginHost.prototype.invoke;
const rpc = AuxiliaryFilesystem.prototype.rpc;
let armed = false, stopped = false;
PluginHost.prototype.invoke = function (handler, args, pre, timeout, options) {
  const offer = args[0] as { path?: string; bytes?: Uint8Array } | undefined;
  const selected = options?.lane === "versioning" &&
    offer?.path === "Count9.md" &&
    new TextDecoder().decode(offer.bytes) === "v10";
  if (selected) armed = true;
  const result = invoke.call(this, handler, args, pre, timeout, options);
  if (selected) {
    const generation = this.generation;
    auditInvocation(result, () => {
      const bytes = Array.from(
        { length: 9 },
        (_, index) => Deno.readTextFileSync(`${vault}/Count9.md.${index}.bak`),
      );
      const files = [...Deno.readDirSync(`${vault}/.globnotes-backup`)].map(
        (item) => item.name,
      );
      Deno.writeTextFileSync(
        `${directory}/completed.json`,
        JSON.stringify({
          generation,
          completedGeneration: this.generation,
          observed: processClock.now(),
          wall: Date.now(),
          bytes,
          files,
        }),
      );
    }, (error) =>
      Deno.writeTextFileSync(
        `${directory}/invocation-error.json`,
        JSON.stringify({ detail: String(error) }),
      )).catch((error) =>
        console.error(
          "Native invocation audit could not record its error",
          error,
        )
      );
  }
  return result;
};
AuxiliaryFilesystem.prototype.rpc = function (
  manifest,
  method,
  args,
  authority,
) {
  if (
    armed && !stopped && method === "fs.remove" &&
    /\/stage-[^/]+-0\.bin$/.test(String(args[0]))
  ) {
    stopped = true;
    Deno.writeTextFileSync(
      `${directory}/before-stop.json`,
      JSON.stringify({
        pid: Deno.pid,
        wall: Date.now(),
        observed: processClock.now(),
        generation: authority.generation,
        journal: JSON.parse(
          Deno.readTextFileSync(`${vault}/.globnotes-backup/active.json`),
        ),
      }),
    );
    Deno.kill(Deno.pid, "SIGSTOP");
  }
  return rpc.call(this, manifest, method, args, authority);
};
await import("../../server/main.ts");
