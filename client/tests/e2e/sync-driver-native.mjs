import {syncCase,assert,until} from "./sync-native-fixture.mjs";
await syncCase("sync-driver-native",async f=>{
  const s=f.session;
  await Deno.writeTextFile(`${f.vault}/Collision.md`,"local collision\n");f.remote.put("Collision.md","remote collision\n");f.remote.put("Live.md","first\n\nlast\n");
  await s.goto(f.url("/"));await f.open();await f.add();await f.active();await f.close();
  await s.poll("[...document.querySelectorAll('.content-column a')].some(a=>a.textContent.includes('Live') && a.getBoundingClientRect().width>0)");
  assert(await Deno.readTextFile(`${f.vault}/Live.md`)==="first\n\nlast\n","Imported note list did not correspond to disk");
  await s.click('.content-column a[href="/Live"]');await s.poll("document.querySelector('.toast-viewer')?.textContent.includes('first')");await s.button("Edit",".content-column");await s.button("Source",".content-column");
  await s.click(".cm-content");await s.key("a",{modifiers:2,code:"KeyA",windowsVirtualKeyCode:65});await s.type("edited in the browser\n\nlast\n");
  await s.button("Save",".content-column");await s.poll("[...document.querySelectorAll('.content-column button')].find(b=>b.textContent.trim()==='Save')?.getAttribute('aria-busy')==='false'");
  await until(()=>f.remote.text("Live.md")==="edited in the browser\n\nlast\n","editor bytes reached remote");
  // Begin the next external edit only after this export's owner acknowledges it.
  await f.waitForExport("Live.md","edited in the browser\n\nlast\n");
  f.remote.put("Live.md","changed on the remote\n\nlast\n");await f.open();await f.sync();await f.close();
  await s.poll("document.querySelector('.cm-content')?.textContent.includes('changed on the remote')");
  assert(await Deno.readTextFile(`${f.vault}/Live.md`)==="changed on the remote\n\nlast\n","Clean editor reload lacks matching disk bytes");
  await s.click(".conflict-badge");await s.poll("document.querySelector('.conflicts-page')?.textContent.includes('Different on both sides') && document.querySelector('.conflicts-page')?.textContent.includes('Home')");
  const conflicts=await f.api("conflicts");assert(conflicts.total===1&&conflicts.conflicts[0].peerLabel==="Home","Collision did not name the instance");
  await s.click(".conflicts-page__row");await s.poll("document.querySelector('[aria-label=\"Conflict copy source\"]')?.textContent==='remote collision\\n'");
  await s.button("Keep conflict copy",".conflicts-page");await s.button("Keep conflict copy","[data-modal-top=true]");
  await until(()=>f.remote.text("Collision.md")==="remote collision\n","resolved bytes reached remote");
  assert(await Deno.readTextFile(`${f.vault}/Collision.md`)==="remote collision\n","Resolution did not reach original disk file");
  assert((await f.api("conflicts")).total===0,"Resolved collision remains open");
  f.results.push({liveListNoReload:true,nativeEditorExport:true,cleanEditorRemoteReload:true,unknownBaseReasonAndLabel:true,resolutionPropagated:true});
});
