// Test-owned observation of the host's durable export acknowledgement, never a
// vault writer, sync request or replacement for the actual remote consumer.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { anonymousPath } from "../../../server/hub/paths.ts";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";

export const exportVersion = content => createHash("sha256").update(content).digest("hex");
export function readExportOwner(state, path, peer = "home") {
  const db = new DatabaseSync(`${state}/hub.sqlite`, {readOnly:true});
  try {
    const file = db.prepare("SELECT hash,seq FROM files WHERE key=?").get(path.normalize("NFC"));
    const secret = db.prepare("SELECT value FROM meta WHERE key='path_secret'").get().value;
    const row = db.prepare("SELECT version,revision,state FROM peer_files WHERE peer=? AND path_key=?").get(peer, anonymousPath(secret,path));
    return {fileVersion:file?.hash??null,fileSeq:file?.seq??null,version:row?.version??null,revision:row?.revision??null,state:row?.state??null};
  } finally { db.close(); }
}
export const exportAcknowledged = (owner, version) => owner.fileVersion === version && owner.version === version && owner.state === "synced" && typeof owner.revision === "string" && !!owner.revision;
/** @param {{peer?:string,onPending?:(owner:ReturnType<typeof readExportOwner>)=>void}} options */
export async function waitForDriverExport(state,path,content,options={}) {
  const {peer="home",onPending}=options;
  const version=exportVersion(content);
  return await waitUntil(()=>{
    const owner=readExportOwner(state,path,peer);
    if(exportAcknowledged(owner,version))return done(owner);
    onPending?.(owner);
    return pending(owner);
  },{label:`host acknowledged export of ${path}`});
}
