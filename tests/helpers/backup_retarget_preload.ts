// SPDX-License-Identifier: LGPL-3.0-only
// Loaded only by the retarget fixture's owned server. Hold one marker RPC at
// the publication boundary; the Worker must not poll while the RPC is held.
import { AuxiliaryFilesystem } from "../../server/plugins/auxiliary_fs.ts";
import { fixtureScope } from "./fixture_scope.ts";
import {
  objectRecordSchema,
  openRecordDirectory,
  recordChannel,
} from "./owned_record_channel.ts";

const vault = Deno.env.get("GLOBNOTES_GLOBNOTES_PATH")!;
const workspace = `${vault}/.globnotes-backup`;
const releaseName = "retarget-release";
const releaseSchema = objectRecordSchema("Retarget release", (value) => {
  if (Object.keys(value).length !== 1 || value.release !== true) {
    throw new TypeError("Invalid retarget release");
  }
  return { release: true };
});
const rpc = AuxiliaryFilesystem.prototype.rpc;
let requested = false;

AuxiliaryFilesystem.prototype.rpc = async function (
  manifest,
  method,
  args,
  authority,
) {
  if (
    manifest.id === "globnotes-backup" && method === "fs.stat" &&
    args[0] === `${workspace}/${releaseName}`
  ) {
    if (requested) {
      throw Error("retarget publication requested release more than once");
    }
    requested = true;
    await fixtureScope((scope) =>
      recordChannel(
        openRecordDirectory(scope, workspace),
        releaseName,
        releaseSchema,
        {
          label: "retarget backup generation",
          exit: authority.generationRetired.then(() => ({ code: 1 })),
        },
      ).wait()
    );
  }
  return rpc.call(this, manifest, method, args, authority);
};
