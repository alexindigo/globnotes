// Feature-owned native case. The preload seam supplies elapsed failure time and
// held transfer state; ordinary driver invalidations and API reads stay real.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { memoryRemote } from "../../../tests/helpers/memory_remote.ts";
import { applicationServer, bindAddress, httpOrigin } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { assert } from "./test-outcomes.mjs";
import { ICON_PATHS } from "../../icons.js";

const directory = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({prefix:"sync-status-"});
const vault=`${directory}/vault`,state=`${vault}/.globnotes`,token="sync-status-native-key";
await Deno.mkdir(`${state}/plugins/globnotes-test-driver`,{recursive:true});
const fixture=new URL("../../../tests/fixtures/plugins/globnotes-test-driver/",import.meta.url);
const manifest=JSON.parse(await Deno.readTextFile(new URL("manifest.json",fixture)));
manifest.capabilities.network=["globnotes.test"];
await Deno.writeTextFile(`${state}/plugins/globnotes-test-driver/manifest.json`,JSON.stringify(manifest));
await Deno.copyFile(new URL("driver.js",fixture),`${state}/plugins/globnotes-test-driver/driver.js`);
const remote=memoryRemote({hostname:bindAddress(),token});
let server,s;
const results=[],requests=[],seam={};
async function api(route,method="GET",body) {
  const response=await fetch(`${server.baseUrl}/_/api/${route}`,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const value=await response.json();assert(response.ok,`${method} ${route}: ${response.status} ${JSON.stringify(value)}`);return value;
}
const controls=()=>Deno.writeTextFile(`${state}/sync-status-test.json`,JSON.stringify(seam));
async function sync(id="office") {const row=(await api("drivers")).instances.find(row=>row.id===id);return api(`drivers/${id}/sync`,"POST",{revision:row.revision});}
async function stateIs(icon,tone) {
  const token=tone==="danger"?"--theme-danger":tone==="active"?"--theme-brand":"--theme-text-muted";
  const snapshot=await s.poll(`(()=>{const el=document.querySelector('[data-sync-status]');if(!el)return false;const style=getComputedStyle(el),paths=[...el.querySelectorAll('path')].map(p=>p.getAttribute('d'));return JSON.stringify(paths)===${JSON.stringify(JSON.stringify(ICON_PATHS[icon]))}&&el.classList.contains(${JSON.stringify(`sync-status__trigger--${tone}`)})?{label:el.getAttribute('aria-label'),color:style.color,tokenColor:'rgb('+style.getPropertyValue(${JSON.stringify(token)}).trim().split(/\\s+/).join(', ')+')'}:false})()`);
  assert(snapshot.color===snapshot.tokenColor,"Sync color does not use the correct theme token");
  const centers=await s.read("[data-sync-status]","[...document.querySelectorAll('nav > div:last-child svg')].map(el=>{const r=el.getBoundingClientRect();return (r.top+r.bottom)/2;})");
  assert(Math.max(...centers)-Math.min(...centers)<=1,"Top-bar icon centerlines differ");
  results.push({icon,tone,...snapshot});return snapshot;
}
async function capture(name) {
  await s.evaluate("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
  const shot=await s.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await Deno.writeFile(`${directory}/${name}.png`,Uint8Array.from(atob(shot.data),c=>c.charCodeAt(0)));
  // Full screenshots are deliverables; these region crops stay working evidence.
  const regions=await s.read("[data-app-shell]",`(()=>{const out={};for(const [name,selector]of Object.entries({toolbar:'nav',page:'.content-column > div:last-child',panel:'#sync-status-panel',sidebar:'[title="Open sidebar"]'})){const r=document.querySelector(selector)?.getBoundingClientRect();if(r&&r.width>0&&r.height>0){const x=Math.max(0,r.x),y=Math.max(0,r.y),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);if(right>x&&bottom>y)out[name]={x,y,width:right-x,height:bottom-y,scale:1};}}return out;})()`);
  await Deno.mkdir(`${directory}/review`,{recursive:true});
  for(const [region,clip]of Object.entries(regions)){const crop=await s.send("Page.captureScreenshot",{format:"png",clip});await Deno.writeFile(`${directory}/review/${name}-${region}.png`,Uint8Array.from(atob(crop.data),c=>c.charCodeAt(0)));}
}
async function geometry() {
  const value=await s.read(["#sync-status-panel","[data-sync-status]"],`(()=>{const panel=document.querySelector('#sync-status-panel'),button=document.querySelector('[data-sync-status]'),icon=button.querySelector('svg');const p=panel.getBoundingClientRect(),b=button.getBoundingClientRect(),i=icon.getBoundingClientRect();return{left:p.left,right:p.right,width:innerWidth,overflow:panel.scrollWidth-panel.clientWidth,gaps:[i.left-b.left,b.right-i.right,i.top-b.top,b.bottom-i.bottom],headers:[...panel.querySelectorAll('li header')].map(el=>[...el.children].map(child=>{const r=child.getBoundingClientRect();return (r.top+r.bottom)/2;})),labels:[...panel.querySelectorAll('h2,h3,button,.driver-state')].map(el=>getComputedStyle(el).whiteSpace)};})()`);
  results.push({geometry:value});
  assert(value.left>=0&&value.right<=value.width&&value.overflow<=1,"Panel escapes narrow viewport");
  assert(Math.max(...value.gaps)-Math.min(...value.gaps)<=1,"Icon slot has unequal padding");
  assert(value.headers.every(centers=>Math.max(...centers)-Math.min(...centers)<=1),"Connection header centerlines differ");
  assert(value.labels.every(space=>space==="nowrap"),"A panel label can wrap");
}
try {
  server=await bootServer({GLOBNOTES_GLOBNOTES_PATH:vault,fixtureAuth:{auth_type:"none"},GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE:"false"},{...applicationServer(),denoArgs:["--import",new URL("../../../tests/helpers/sync_status_preload.ts",import.meta.url).pathname]});
  const catalog=await api("plugin-host");await api("plugin-host/globnotes-test-driver/enabled","PUT",{enabled:true,revision:catalog.policy.revision,signature:catalog.policy.signature});
  const permission=await api("plugin-host/globnotes-test-driver/permissions");await api("plugin-host/globnotes-test-driver/permissions","PUT",{revision:permission.revision,signature:permission.signature,requestSourceKey:permission.requestSourceKey,requestSourceRevision:permission.requestSourceRevision,allowNetwork:true,approvedNetwork:permission.requestedNetwork,approvedImports:[]});
  await api("notes","POST",{path:"Welcome",content:"# A connected vault\n\nNotes stay together across your sync connections.\n"});
  for(const label of ["Home","Office"]) {
    const settings={baseUrl:httpOrigin(new URL(remote.baseUrl).port)};
    const created=await api("drivers","POST",{plugin:"globnotes-test-driver",label,settings});
    const keyed=await api(`drivers/${created.id}/secrets/token`,"PUT",{revision:created.revision,value:token});
    await api(`drivers/${created.id}`,"PUT",{revision:keyed.revision,label,settings,enabled:true});
  }
  s=await nativeSession({port:Number(Deno.env.get("CDP_PORT")??9335),width:1280,height:1000});
  await s.send("Emulation.setTimezoneOverride",{timezoneId:"America/Los_Angeles"});
  s.page.onEvent(event=>{if(event.method==="Network.requestWillBeSent")requests.push({url:event.params.request.url,method:event.params.request.method});});
  await s.goto(`${server.baseUrl}/Welcome`);
  await stateIs("tabCloud","idle");await capture("idle");
  seam.activities={office:"sending"};await controls();await sync();await stateIs("tabCloudUpload","active");
  seam.activities={office:"receiving",home:"sending"};await controls();await sync();
  await stateIs("tabCloudDownload","active");await capture("receiving");
  // A real remote failure, with only its wall-clock onset supplied by the seam.
  seam.failureSince={home:Date.now()-180_000};seam.activities.home=null;await controls();
  remote.faults.push({path:"/list",status:503,message:"Remote unavailable",retryAfterMs:300_000});
  await sync("home");
  const failed=(await api("drivers")).instances.find(row=>row.id==="home");assert(failed.status==="failed"&&failed.failingSince<=Date.now()-120_000,"Failure seam did not reach the real server projection");
  await stateIs("tabCloudDownload","danger");await capture("problem-syncing");
  seam.activities={office:null};await controls();await sync();
  await stateIs("tabCloudExclamation","danger");
  await s.click("[data-sync-status]");
  const panel=await s.read("#sync-status-panel","document.querySelector('#sync-status-panel').textContent");
  assert(panel.includes("Home")&&panel.includes("Office")&&panel.includes("Failed")&&panel.includes("Active")&&panel.includes("Next retry:")&&panel.includes("Last sync:"),"Panel did not show both actual connection states");
  await geometry();await capture("problem-stopped-open");
  const ax=await s.send("Accessibility.getFullAXTree");assert(ax.nodes.some(node=>node.role?.value==="dialog"&&node.name?.value==="Sync"),"Panel is not named in accessibility tree");
  await s.key("Tab",{windowsVirtualKeyCode:9});assert(await s.read("#sync-status-panel","document.activeElement?.textContent==='Open Sync settings'"),"Tab did not reach settings link");
  await s.key("Escape",{windowsVirtualKeyCode:27});assert(await s.read("[data-sync-status]","document.activeElement?.matches('[data-sync-status]')&&!document.querySelector('#sync-status-panel')"),"Escape did not restore trigger focus");
  // Enter includes its native character event; a raw key event with no text
  // does not exercise Chromium's button activation default.
  await s.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",text:"\r",unmodifiedText:"\r",windowsVirtualKeyCode:13});
  await s.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});await s.read("#sync-status-panel","true");
  // Model browsers where a pointer press on the trigger does not focus it:
  // blur yields null relatedTarget before the one trusted click arrives.
  await s.evaluate("document.querySelector('[data-sync-status]').addEventListener('pointerdown',event=>{event.preventDefault();document.activeElement?.blur();},{once:true})");
  await s.click("[data-sync-status]");assert(await s.read("[data-sync-status]","!document.querySelector('#sync-status-panel')"),"A non-focusing trigger click reopened the panel");
  await s.click("[data-sync-status]");await s.read("#sync-status-panel","true");
  await s.click(".sync-status__settings");await s.read("[data-sync-settings]","true");
  await s.click('[aria-label="Close settings"]');await s.click("[data-sync-status]");
  await s.send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:false});await geometry();await capture("narrow-working");
  await s.send("Emulation.setDeviceMetricsOverride",{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await s.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});await s.poll("document.body.classList.contains('dark')");await geometry();await capture("problem-stopped-open-dark");
  // Recovery removes danger through the same existing driver invalidation.
  delete seam.failureSince;await controls();await sync("home");await stateIs("tabCloud","idle");
  for(const instance of (await api("drivers")).instances)await api(`drivers/${instance.id}`,"PUT",{revision:instance.revision,label:instance.label,settings:instance.settings,enabled:false});
  await s.poll("!document.querySelector('[data-sync-status]')");
  assert(s.errors.length===0,`Browser exceptions: ${JSON.stringify(s.errors)}`);
  results.push({plainHttp:true,secure:false,keyboard:true,settingsIntent:true,narrow:true,dark:true,recovery:true,offHidden:true});
  await Deno.writeTextFile(`${directory}/results.json`,JSON.stringify({results,requests,events:s.events},null,2));
  console.log(JSON.stringify({case:"sync-status-native",results,artifacts:directory}));
} catch(error) {
  if(s){await capture("failure").catch(()=>{});await Deno.writeTextFile(`${directory}/failure.json`,JSON.stringify({error:String(error),dom:await s.evaluate("document.body.innerText").catch(()=>null),server:server?.logs(),results,events:s.events,errors:s.errors},null,2));}
  throw error;
} finally { await s?.close();await server?.close();await remote.close(); }
