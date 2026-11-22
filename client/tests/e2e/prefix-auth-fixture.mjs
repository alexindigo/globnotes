// Feature-owned production cwd: prefix stamping never changes donor assets.
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
import { testOrigin } from "./http-origin.mjs";
import { done, failed, pending, waitUntil, watchChild } from "../../../tests/helpers/wait.ts";
import { metadataBase } from "./config-fixture.mjs";
import { resolve } from "node:path";
import { createFixtureScope } from "../../../tests/helpers/fixture_scope_engine.ts";
import { fixtureLayout } from "../../../tests/helpers/fixture_layout.ts";
import { repositoryBuild } from "../../../tests/helpers/completed_build.ts";
import { spawnOwnedChild } from "../../../tests/helpers/owned_child.ts";
import { workMilestone } from "../../../tests/helpers/product_settlement.ts";
import { boundOperation } from "../../../tests/helpers/owned_operation.ts";
import { fixtureScope } from "../../../tests/helpers/fixture_scope.ts";
import { UnexpectedServerExitError } from "../../../tests/helpers/boot.ts";
const assert = (value, message) => { if (!value) throw Error(message); };
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");

export async function bootPrefixAuthFixture({ directory, vault, state, prefix, setup, headers, healthFetch=fetch, catalogFetch=fetch, originDependencies }) {
  const lifetime=createFixtureScope();
  headers={...headers};
  const origin=testOrigin(originDependencies);
  return lifetime.prepare(async scope => {
  directory=resolve(directory);vault=resolve(vault);state=resolve(state);
   const build=(await scope.admit(()=>repositoryBuild(scope,{required:true}))).value;
  const layout=await fixtureLayout(scope,{GLOBNOTES_GLOBNOTES_PATH:vault,GLOBNOTES__METADATA_PATH:metadataBase(vault,state)},{build,artifacts:directory});
  const cwd=layout.cwd,assets=build.assets;
  const donorSnapshot=async()=>{
    const rows=[];
    for(const row of assets){let sha256=null;try{sha256=await hash(await Deno.readFile(`${ROOT}/client/dist/${row.path}`));}catch(error){if(!(error instanceof Deno.errors.NotFound))throw error;}rows.push({path:row.path,sha256});}
    return rows;
  };
  const donorAssets=(await scope.admit(donorSnapshot)).value;
   await scope.admit(async signal=>{
   for (const row of assets) { signal.throwIfAborted(); assert(await hash(await Deno.readFile(`${cwd}/client/dist/${row.path}`)) === row.sha256, "Production asset copy mismatch"); }
   await Deno.writeTextFile(`${directory}/production-assets-before.json`, JSON.stringify({ sourceRoot: ROOT, cwd, assets, donorAssets }, null, 2), { createNew: true });
   });
   const hostname = origin.address;
   const port = (await scope.admit(()=>{const listener=Deno.listen({hostname,port:0});try{return listener.addr.port;}finally{listener.close();}})).value;
  let draining=Promise.resolve();scope.defer(()=>draining);
   const owner = (await spawnOwnedChild(scope,Deno.execPath(), {
    args: ["run", "--cached-only", "--frozen", `--config=${ROOT}/deno.json`, "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", `${ROOT}/server/main.ts`],
    cwd,
    env: { ...layout.environment, GLOBNOTES__SERVER_PATHPREFIX: prefix, GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false", GLOBNOTES__SERVER_HOST: hostname, GLOBNOTES__SERVER_PORT: String(port) },
    stdout: "piped", stderr: "piped",
   })).value;
  const child={pid:owner.pid,status:owner.exited,stdout:owner.stdout,stderr:owner.stderr};
  const exited=new AbortController();
  child.status.then(status=>exited.abort(Error(`Prefix fixture server exited: ${status.code}`)),error=>exited.abort(error));
  const ownerGone=AbortSignal.any([scope.signal,exited.signal]);
  const baseUrl = `http://${origin.host}:${port}`, logs = { stdout: "", stderr: "" };
   const drains = ["stdout", "stderr"].map(name => {
    let collection;
    const admission=scope.admit(()=>collection=(async () => {
    const file = await Deno.open(`${directory}/server-${name}.log`, { write: true, createNew: true }).catch(error=>fixtureScope(cleanup=>{
      // A successful child acquisition transfers both read ends to these drains.
      // If log acquisition fails, no iterator has taken custody of this pipe.
      cleanup.defer(()=>child[name].cancel());
      throw error;
    }));
    try {
      for await (const chunk of child[name]) {
        logs[name] += new TextDecoder().decode(chunk);
        let offset = 0; while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
      }
    } finally { file.close(); }
   })());
    // Cleanup joins real pipe IO, not the expected retired-admission rejection.
    // IO still begins only inside admission and all genuine failures remain in
    // collection; observing the envelope cannot hide a collection failure.
    admission.catch(()=>{});
    return collection??admission;
   });
  draining=Promise.all(drains);
  let drainFailure;
  draining.catch(error=>{drainFailure={error};});
  // Pipe EOF never stands in for process exit. A failed drain rejects at once;
  // a successful one joins the actual child status before bounding readiness.
  const streamOwner=draining.then(()=>child.status);
  streamOwner.catch(()=>{});
   await scope.admit(()=>Deno.writeTextFile(`${directory}/startup-ownership.json`, JSON.stringify({ pid: child.pid, vault, state, prefix, port, cwd, sourceRoot: ROOT,instance:layout.instance }), { createNew: true }));
  let closing,returned=false;
  function close() {return closing??=(async()=>{
    try {
    if(!scope.signal.aborted){
    if(returned&&owner.status())throw new UnexpectedServerExitError(`Prefix fixture server exited on its own before close() (pid ${child.pid}, exit code ${owner.status().code})`);
    await owner.terminate(5000);
    await draining;
     await scope.admit(async()=>assert(JSON.stringify(await donorSnapshot())===JSON.stringify(donorAssets),"Donor production assets changed during prefix fixture"));
    }
    } catch(error) {await lifetime.close(error);throw error;}
    await lifetime.close();
  })();}
  const children = [watchChild(child, () => logs)];
  try {
     await workMilestone(streamOwner,scope.admit(async scopeSignal=>{
     await waitUntil(async signal=>{
       const combined=AbortSignal.any([signal,scopeSignal,ownerGone]);
       try {
          const response=await boundOperation({signal:combined,dispose:response=>response.body?.cancel()},signal=>healthFetch(`${baseUrl}${prefix}/_/api/health`,{signal}));
         combined.throwIfAborted();
         return response.ok?done():pending({health:response.status});
       }catch(error){combined.throwIfAborted();return pending({health:String(error)});}
     },{label:"Prefix fixture health",intervalMs:50,children});
     ownerGone.throwIfAborted();
     await waitUntil(async signal => {
       const combined=AbortSignal.any([signal,scopeSignal,ownerGone]);
       const response = await boundOperation({signal:combined,dispose:response=>combined.aborted?response.body?.cancel():undefined},signal=>catalogFetch(`${baseUrl}${prefix}/_/api/plugin-host`, { headers, signal }));
        const text=await fixtureScope(async bodyScope=>{
          const reader=(await bodyScope.acquire(()=>response.body?.getReader(),reader=>{
            if(!reader)return;
            try{reader.cancel().catch(()=>{});}finally{reader.releaseLock();}
          })).value;
          return await boundOperation({signal:combined,dispose:()=>{}},async()=>{
            if(!reader)return "";
            const decoder=new TextDecoder();let text="";
            for(;;){const chunk=await reader.read();if(chunk.done)return text+decoder.decode();text+=decoder.decode(chunk.value,{stream:true});}
          });
        });
        const catalog=JSON.parse(text);
       combined.throwIfAborted();
      if (setup) { assert(response.status === 503, "Setup catalogue did not reject before runtime"); return done(); }
      assert(response.ok, `Prefix catalogue rejected: ${response.status}`);
      const plugin = catalog.plugins.find(plugin => plugin.id === "gps08");
      if (plugin?.status === "failed") return failed("Prefix fixture Worker failed rather than becoming ready", plugin);
      if (plugin?.status === "ready" && plugin.commands.some(command => command.id === "consume")) return done();
      return pending(plugin ?? { id: "gps08", status: "absent" });
     }, { label: "Prefix fixture actual command readiness", intervalMs: 50, children });
    ownerGone.throwIfAborted();
   returned=true;
     }),"Prefix fixture readiness before child exit");
    } catch (error) { const primary=drainFailure?drainFailure.error:exited.signal.aborted?exited.signal.reason:error;try{await close();}catch(cleanup){if(Object.is(cleanup,primary))throw primary;throw new AggregateError([primary,cleanup],"Prefix fixture startup and cleanup failed",{cause:primary});}throw primary; }
   ownerGone.throwIfAborted();
  return { baseUrl, pid: child.pid, logs, close, cwd, assets };
  });
}
