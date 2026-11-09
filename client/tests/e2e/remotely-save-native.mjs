import { remotelySaveCase, assert, until } from "./remotely-save-fixture.mjs";
assert(Deno.args.length === 2, "Expected backend and codec arguments");
await remotelySaveCase(Deno.args[0], Deno.args[1], async f=>{
  const {s,scope}=f;
  const visible=await s.read(scope, `({fields:[...document.querySelectorAll('${scope} .driver-instance__settings [id^="driver-home-"]')].map(el=>el.id),keys:[...document.querySelectorAll('${scope} .driver-secret input')].map(el=>el.id),secure:isSecureContext})`);
  assert(!visible.secure,"Sync visibility must be observed on ordinary HTTP");
  assert(visible.fields.some(id=>id.includes(f.backend==='s3'?'s3Endpoint':'webdavUrl'))&&!visible.fields.some(id=>id.includes(f.backend==='s3'?'webdavUrl':'s3Endpoint')), "Backend fields do not match the selected backend");
  assert(JSON.stringify(visible.keys)===JSON.stringify([...(f.backend==='s3'?['s3_access_key','s3_secret_key','s3_session_token']:[]),...(f.mode==='none'?[]:['encryption_password'])].map(key=>`driver-key-home-${key}`)), "Keys do not match backend, authentication and encryption");
  await f.geometry("desktop"); await f.capture("active");
  await f.close();
  await s.poll("[...document.querySelectorAll('.content-column a')].some(a=>a.textContent.includes('Live')&&a.getBoundingClientRect().width>0)");
  assert(await Deno.readTextFile(`${f.vault}/Live.md`)==="first\n\nlast\n", "List import differs from disk");
  await s.click('.content-column a[href="/Live"]');
  await s.poll("document.querySelector('.toast-viewer')?.textContent.includes('first')");
  await s.button("Edit", ".content-column"); await s.button("Source", ".content-column");
  await s.click(".cm-content"); await s.key("a",{modifiers:2,code:"KeyA",windowsVirtualKeyCode:65}); await s.type("edited in the browser\n\nlast\n");
  await s.button("Save", ".content-column");
  await s.poll("[...document.querySelectorAll('.content-column button')].find(b=>b.textContent.trim()==='Save')?.getAttribute('aria-busy')==='false'");
  await until(async()=>await f.read("Live.md")==="edited in the browser\n\nlast\n", "native editor output at remote");
  // Remote bytes precede upload verification and the host's settled receipt.
  await f.waitForExport("Live.md","edited in the browser\n\nlast\n");
  await f.put("Live.md", "changed on the remote\n\nlast\n"); await f.open(); await f.sync(); await f.close();
  await s.poll("document.querySelector('.cm-content')?.textContent.includes('changed on the remote')");
  assert(await Deno.readTextFile(`${f.vault}/Live.md`)==="changed on the remote\n\nlast\n", "Clean editor differs from imported disk");
  await f.capture("editor");
  await s.click(".conflict-badge");
  await s.poll("document.querySelector('.conflicts-page')?.textContent.includes('Different on both sides')&&document.querySelector('.conflicts-page')?.textContent.includes('Home')");
  const conflicts=await f.api("conflicts"); assert(conflicts.total===1&&conflicts.conflicts[0].peerLabel==="Home", "Unexpected conflict count/owner");
  await s.click(".conflicts-page__row");
  await s.poll("document.querySelector('[aria-label=\"Conflict copy source\"]')?.textContent==='remote collision\\n'"); await f.capture("conflict");
  await s.button("Keep conflict copy", ".conflicts-page"); await s.button("Keep conflict copy", "[data-modal-top=true]");
  await until(async()=>await f.read("Collision.md")==="remote collision\n", "resolved bytes at remote");
  assert(await Deno.readTextFile(`${f.vault}/Collision.md`)==="remote collision\n"&&(await f.api("conflicts")).total===0, "Resolution did not reach disk/inbox");
  await f.open();
  if(f.mode!=="none") {
    await s.button("Clear", '.driver-secret:has(#driver-key-home-encryption_password)'); await f.controls();
    await s.poll(`document.querySelector('${scope} .driver-instance__state')?.textContent==='Locked'`);
    assert(!(await f.api("drivers")).instances[0].secrets.find(row=>row.key==='encryption_password').set, "Cleared key remains set");
    assert(await Deno.readTextFile(`${f.vault}/Live.md`)==="changed on the remote\n\nlast\n", "Key clear changed live file");
    await f.key("encryption_password", "native-only-passphrase-canary"); await f.active();
  }
  if(f.captures) {
    await f.rows("sync-desktop");
    await f.open("Editor"); await f.rows("editor-desktop"); await f.capture("editor-settings-desktop"); await f.open();
    // One native Tab traversal, preserving every field/action and modal focus.
    await s.click('[aria-label="Close settings"]'); await f.open();
    const count=await s.read('[role=dialog]', "[...document.querySelectorAll('[role=dialog] button,[role=dialog] input,[role=dialog] select,[role=dialog] textarea')].filter(el=>el.tabIndex>=0&&!el.disabled&&el.getBoundingClientRect().width).length");
    await s.evaluate("[...document.querySelectorAll('[role=dialog] button,[role=dialog] input,[role=dialog] select,[role=dialog] textarea')].filter(el=>el.tabIndex>=0&&!el.disabled&&el.getBoundingClientRect().width).forEach((el,index)=>el.setAttribute('data-remotely-focus',String(index)))");
    const visited=new Set();
    for(let i=0;i<count+2;i++) {
      const focus=await s.read('[role=dialog]', "({id:document.activeElement?.getAttribute('data-remotely-focus'),inside:document.querySelector('[role=dialog]').contains(document.activeElement)})");
      assert(focus.inside,"Keyboard escaped Settings"); visited.add(focus.id); await s.key("Tab",{windowsVirtualKeyCode:9});
    }
    assert(Array.from({length:count},(_,i)=>String(i)).every(id=>visited.has(id)), "Keyboard missed a Settings action");
    await s.send("Emulation.setDeviceMetricsOverride",{width:480,height:2600,deviceScaleFactor:1,mobile:false}); await f.geometry("narrow"); await f.rows("sync-narrow"); await f.capture("narrow");
    await f.open("Editor"); await f.rows("editor-narrow"); await f.capture("editor-settings-narrow"); await f.open();
    await s.send("Emulation.setDeviceMetricsOverride",{width:1280,height:2200,deviceScaleFactor:1,mobile:false});
    await s.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]}); await s.poll("document.body.classList.contains('dark')");
    await f.geometry("dark"); await f.capture("dark");
    f.results.push({keyboardActions:count});
  }
  f.results.push({nativeEnableConsent:true,backendAndCodecPersisted:true,liveListNoReload:true,nativeEditorExport:true,cleanEditorReload:true,collisionOwnerAndResolution:true,keyClear:f.mode!=="none"});
});
