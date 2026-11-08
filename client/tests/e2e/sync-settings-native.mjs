import {syncCase,assert,until} from "./sync-native-fixture.mjs";
await syncCase("sync-settings-native",async f=>{
  const s=f.session;
  f.remote.put("Welcome.md","remote welcome\n");f.remote.put("Restore.md","restore base\n");f.remote.put("Delete.md","delete base\n");
  await s.goto(f.url("/"));await f.open();await f.capture("empty");
  await f.add("wrong-token");await s.poll("document.querySelector('.driver-instance__state')?.textContent==='Locked'");
  assert(await f.absent("Welcome.md"),"Wrong key imported a file");await f.capture("locked");
  await f.fill("#driver-key-home-token",f.token);await f.capture("key-entry");await s.button("Save key",".driver-instance");await f.active();
  await s.poll("document.querySelector('#driver-key-home-token')?.value===''");
  assert(await Deno.readTextFile(`${f.vault}/Welcome.md`)==="remote welcome\n","Active state preceded import outcome");
   assert(await s.read('.driver-instance', "document.querySelector('.driver-instance').textContent.includes('This storage cannot check versions while writing; a change made there at the same moment can be overwritten.')"),"Static emulation disclosure missing");
  await f.geometry("desktop");await f.capture("active");
  // Native Tab visits every rendered action, including fields/actions below the fold.
  await s.click('[aria-label="Close settings"]');await f.open();
  const expected=await s.evaluate("[...document.querySelectorAll('[role=dialog] button,[role=dialog] input,[role=dialog] select,[role=dialog] textarea')].filter(el=>el.tabIndex>=0&&!el.disabled&&el.getBoundingClientRect().width).map((el,index)=>{el.setAttribute('data-sync-focus',String(index));return String(index);})");
  const visited=new Set();for(let i=0;i<expected.length+2;i++){visited.add(await s.evaluate("document.activeElement?.getAttribute('data-sync-focus')"));await s.key("Tab",{windowsVirtualKeyCode:9});}
  assert(expected.every(id=>visited.has(id)),"Keyboard did not reach every Settings action");
  await s.send("Emulation.setDeviceMetricsOverride",{width:480,height:1600,deviceScaleFactor:1,mobile:false});await f.geometry("narrow");await f.capture("narrow");
  await s.send("Emulation.setDeviceMetricsOverride",{width:1280,height:1400,deviceScaleFactor:1,mobile:false});await s.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});await s.poll("document.body.classList.contains('dark')");await f.geometry("dark");await f.capture("dark");
  // A newer key/draft cannot be discarded by closing Settings or choosing a page.
  await f.fill("#driver-home-prefix","retained-draft");await s.button("Plugins","[role=dialog] nav");await s.button("Keep editing","[data-modal-top=true]");
  assert(await s.evaluate("document.querySelector('#driver-home-prefix')?.value==='retained-draft'"),"Departure cancelled but lost Sync draft");await s.button("Discard edits",".driver-instance");await s.button("Discard edits","[data-modal-top=true]");
  // Unknown metadata response after real effects: review reads, never replays.
  let paused;const release=s.page.onEvent(event=>{if(event.method==="Fetch.requestPaused")paused=event.params.requestId;});
  try{
    await s.send("Fetch.enable",{patterns:[{urlPattern:"*/_/api/drivers/home",requestStage:"Response"}]});
    await f.fill("#driver-home-forbiddenCharacters","?");await s.button("Save settings",".driver-instance");await until(()=>!!paused,"settings response after actual commit");
    const before=f.writes.length;await s.send("Fetch.failRequest",{requestId:paused,errorReason:"Failed"});await s.send("Fetch.disable");
     await s.poll("document.querySelector('[data-sync-settings]')?.textContent.includes('outcome is unknown')");await s.button("Review current state","[data-sync-settings]");
    assert(f.writes.length===before,"Read-back replayed an unknown metadata request");
    await s.button("Discard edits",".driver-instance");await s.button("Discard edits","[data-modal-top=true]");
  }finally{release();await s.send("Fetch.disable");}
  await s.click('.driver-instance__header [role="switch"]');await s.poll("document.querySelector('.driver-instance__state')?.textContent==='Off'");
  for(const path of ["Restore","Delete"]){const note=await f.api(`notes/${path}`);await f.api(`notes/${path}?base_version=${note.version}`,"DELETE");f.remote.put(`${path}.md`,`${path} edited remotely\n`);}
  await s.click('.driver-instance__header [role="switch"]');await f.active();await s.poll("document.querySelector('[aria-label=\"Deleted here\"]')?.textContent.includes('2 files deleted here')");await f.capture("attention");
  const restore='[aria-label="Deleted here"] li:first-child';
   const first=await s.read(restore, `document.querySelector(${JSON.stringify(restore)}).textContent`);
  // Both explicit per-file outcomes reach the folder and the remote.
  if(first.includes("Restore.md")){await s.button("Restore here",restore);await s.button("Delete on Home",'[aria-label="Deleted here"]');}
  else{await s.button("Delete on Home",restore);await s.button("Restore here",'[aria-label="Deleted here"]');}
  await until(async()=>!await f.absent("Restore.md")&&!f.remote.objects.has("Delete.md"),"held choices at disk and remote");
  assert(await Deno.readTextFile(`${f.vault}/Restore.md`)==="Restore edited remotely\n","Restore did not use remote bytes");
  f.remote.clear();await f.sync();await s.poll("!!document.querySelector('[aria-label=\"Remote looks empty\"]')");await s.button("Upload them again",".driver-instance");
  await until(()=>f.remote.objects.has("Welcome.md")&&f.remote.objects.has("Restore.md"),"remote-empty upload outcome");
  f.remote.clear();await f.sync();await s.poll("!!document.querySelector('[aria-label=\"Remote looks empty\"]')");await s.button("Delete these 2 files here too",".driver-instance");
  await until(async()=>await f.absent("Welcome.md")&&await f.absent("Restore.md"),"remote-empty deletion outcome");
  await f.api("notes","POST",{path:"Survivor",content:"keep on both sides\n"});await until(()=>f.remote.text("Survivor.md")==="keep on both sides\n","survivor export");
  await s.button("Remove",".driver-instance");await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Files in this vault and on Home stay as they are.')");await s.button("Remove","[data-modal-top=true]");
   await s.poll("document.querySelector('[data-sync-settings]')?.textContent.includes('No sync set up.')");assert(await Deno.readTextFile(`${f.vault}/Survivor.md`)==="keep on both sides\n"&&f.remote.text("Survivor.md")==="keep on both sides\n","Removal deleted user files");
  assert((await f.api("drivers")).instances.length===0,"Removed instance remains readable");const keyBytes=await Deno.readFile(`${f.state}/driver-secrets.sqlite`);assert(!new TextDecoder().decode(keyBytes).includes(f.token),"Removal left secret bytes in SQLite");
  f.results.push({nativeAdd:true,wrongKeyLocked:true,plainHttpKey:true,keyboardActions:expected.length,departureRetained:true,unknownReadNoReplay:true,heldRestoreDelete:true,remoteEmptyBothChoices:true,removalPreservesFiles:true,keySecurelyRemoved:true});
});
