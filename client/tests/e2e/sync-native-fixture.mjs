// M5-owned real HTTP provider, Worker plugin, disk and native browser input.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { memoryRemote } from "../../../tests/helpers/memory_remote.ts";
import { applicationServer, bindAddress, httpOrigin } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { assert } from "./test-outcomes.mjs";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
export { assert };
export const until = (predicate, label) => waitUntil(async () => await predicate() ? done() : pending({label}), {label,intervalMs:50});
export async function syncCase(name, run) {
  const parent = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({prefix:"m5-native-"});
  const directory = `${parent}/${name}`, vault=`${directory}/vault`, state=`${vault}/.globnotes`;
  await Deno.mkdir(`${state}/plugins/globnotes-test-driver`,{recursive:true});
  const fixture=new URL("../../../tests/fixtures/plugins/globnotes-test-driver/",import.meta.url);
  const manifest=JSON.parse(await Deno.readTextFile(new URL("manifest.json",fixture)));
  manifest.capabilities.network=["globnotes.test"];
  // Exercise the required static disclosure as well as actual native conditions.
  manifest.driver.capabilities.mutations.create="emulated";
  await Deno.writeTextFile(`${state}/plugins/globnotes-test-driver/manifest.json`,JSON.stringify(manifest));
  await Deno.copyFile(new URL("driver.js",fixture),`${state}/plugins/globnotes-test-driver/driver.js`);
  const token="m5-browser-secret-marker-72819";
  const remote=memoryRemote({hostname:bindAddress(),token});
  const remoteUrl=httpOrigin(new URL(remote.baseUrl).port);
  let server,session;
  const results=[], writes=[];
  async function api(route,method="GET",body) {
    const response=await fetch(`${server.baseUrl}/_/api/${route}`,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const value=await response.json();assert(response.ok,`${method} ${route}: ${response.status}`);return value;
  }
  async function capture(label) {
    await session.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    const full=await session.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    await Deno.writeFile(`${directory}/${label}.png`,Uint8Array.from(atob(full.data),c=>c.charCodeAt(0)));
    const regions=await session.evaluate(`(()=>{const selectors={shell:'[data-app-shell]',frame:'[role=dialog]',navigation:'[role=dialog] nav',content:'[data-settings-content]',instance:'.driver-instance',keys:'.driver-secret',attention:'.driver-instance__attention'};const regions={};for(const [name,selector]of Object.entries(selectors)){const r=document.querySelector(selector)?.getBoundingClientRect();if(!r||r.width<1||r.height<1)continue;const x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);if(right>x&&bottom>y)regions[name]={x,y,width:right-x,height:bottom-y,scale:1};}return regions;})()`);
    await Deno.mkdir(`${directory}/review`,{recursive:true});
    await Deno.writeTextFile(`${directory}/review/${label}-regions.json`,JSON.stringify(regions,null,2));
    for(const [name,clip]of Object.entries(regions)) {const crop=await session.send("Page.captureScreenshot",{format:"png",clip});await Deno.writeFile(`${directory}/review/${label}-${name}.png`,Uint8Array.from(atob(crop.data),c=>c.charCodeAt(0)));}
  }
  try {
    server=await bootServer({GLOBNOTES_PATH:vault,GLOBNOTES_INDEX_PATH:state,GLOBNOTES_AUTH_TYPE:"none",GLOBNOTES_AUTO_ENABLE_PLUGINS:"false"},applicationServer());
    const catalog=await api("plugin-host");await api("plugin-host/globnotes-test-driver/enabled","PUT",{enabled:true,revision:catalog.policy.revision,signature:catalog.policy.signature});
    const permission=await api("plugin-host/globnotes-test-driver/permissions");
    await api("plugin-host/globnotes-test-driver/permissions","PUT",{revision:permission.revision,signature:permission.signature,requestSourceKey:permission.requestSourceKey,requestSourceRevision:permission.requestSourceRevision,allowNetwork:true,approvedNetwork:permission.requestedNetwork,approvedImports:[]});
    session=await nativeSession({port:Number(Deno.env.get("CDP_PORT")??9335),width:1280,height:1400});
    session.page.onEvent(event=>{if(event.method==="Network.requestWillBeSent"&&event.params.request.url.includes("/_/api/drivers")&&event.params.request.method!=="GET")writes.push({method:event.params.request.method,path:new URL(event.params.request.url).pathname});});
    const f={directory,vault,state,remote,remoteUrl,token,session,api,capture,results,writes,
      url:path=>`${server.baseUrl}${path}`,
      async open() {
        if(!await session.evaluate("!!document.querySelector('#settings-modal-title')")){
          if(await session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')"))await session.click('[title="Open sidebar"]');
          await session.click('[aria-label="Settings"]');
        }
        await session.button("Sync","[role=dialog]");await session.poll("!!document.querySelector('[data-sync-settings]') && !document.querySelector('[data-sync-settings]').textContent.includes('Loading sync settings...')");
      },
      async close() {
        await session.click('[aria-label="Close settings"]');
        await session.poll("!document.querySelector('#settings-modal-title')");
        if(await session.evaluate("document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width>0"))await session.click('[title="Close sidebar"]');
      },
      async fill(selector,text) {await session.click(selector);await session.key("a",{modifiers:2,code:"KeyA",windowsVirtualKeyCode:65});await session.type(text);await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(text)}`);},
      // A PUT receipt clears busy before its owning snapshot restores controls.
      // Wait for that rendered consumer, not just the absence of a busy flag:
      // restored Add/Remove rows change the position of lower fields.
      async controlsReady() {await session.poll("!!document.querySelector('.driver-instance__header [role=switch]') && !document.querySelector('[data-sync-settings] [aria-busy=true]')");},
      async key(value) {await f.fill('#driver-key-home-token',value);await session.button("Save key",".driver-instance");await session.poll("document.querySelector('#driver-key-home-token')?.value===''");await f.controlsReady();},
      async one(){return (await api("drivers")).instances.find(row=>row.id==="home");},
      async sync(){await session.button("Sync now",".driver-instance");await f.controlsReady();},
      async active(){await session.poll("document.querySelector('.driver-instance__state')?.textContent==='Active'");},
      async add(key=token) {
        await session.button("Add","[data-sync-settings]");await f.fill("#sync-label","Home");await session.button("Add instance","[data-sync-settings]");
        await session.poll("document.querySelector('.driver-instance__state')?.textContent==='Off'");await f.controlsReady();
        await f.fill("#driver-home-baseUrl",remoteUrl);await session.button("Save settings",".driver-instance");await f.controlsReady();
        await f.key(key);await session.click('.driver-instance__header [role="switch"]');
      },
      async absent(path){return await Deno.stat(`${vault}/${path}`).then(()=>false,error=>{if(error instanceof Deno.errors.NotFound)return true;throw error;});},
      async privacy() {const dump=await session.evaluate("JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookies:document.cookie})");for(const marker of [token,encodeURIComponent(token),btoa(token)])assert(!dump.includes(marker),"Driver key reached browser storage");assert(!JSON.stringify(server.logs()).includes(token),"Driver key reached process logs");},
      async geometry(label) {
        const geometry=await session.read(['[data-settings-content]', '.driver-instance__header', '[role=dialog]'], `(()=>{const column=document.querySelector('[data-settings-content]').getBoundingClientRect();const header=[...document.querySelectorAll('.driver-instance__header > *')].map(el=>({name:el.tagName,rect:el.getBoundingClientRect().toJSON()}));const actions=[...document.querySelectorAll('[data-sync-settings] button')].filter(el=>el.getBoundingClientRect().width).map(el=>({text:el.textContent,rect:el.getBoundingClientRect().toJSON()}));const labels=[...document.querySelectorAll('[data-sync-settings] label')].map(el=>({text:el.textContent,height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight),whiteSpace:getComputedStyle(el).whiteSpace}));return {column:column.toJSON(),header,actions,labels,overflow:document.querySelector('[role=dialog]').scrollWidth-document.querySelector('[role=dialog]').clientWidth};})()`);
        assert(geometry.overflow<=1,"Sync dialog has horizontal overflow");
        assert(geometry.actions.every(({rect})=>rect.left>=geometry.column.left-1&&rect.right<=geometry.column.right+1),"Sync action escaped content column");
        assert(geometry.labels.every(item=>item.whiteSpace==="nowrap"||item.height<=item.line+1),"A Sync label wrapped");
        const header=geometry.header.filter(({rect})=>rect.top===geometry.header[0]?.rect.top||Math.abs((rect.top+rect.bottom)/2-(geometry.header[0].rect.top+geometry.header[0].rect.bottom)/2)<1);
        if(label==="desktop")assert(header.length===geometry.header.length&&Math.max(...header.map(({rect})=>(rect.top+rect.bottom)/2))-Math.min(...header.map(({rect})=>(rect.top+rect.bottom)/2))<=1,"Sync header centerlines differ");
        results.push({label,geometry});
      },
    };
    await run(f);await f.privacy();assert(session.errors.length===0,`Browser exceptions: ${JSON.stringify(session.errors)}`);
    await Deno.writeTextFile(`${directory}/results.json`,JSON.stringify({results,writes,events:session.events},null,2));console.log(JSON.stringify({case:name,results,artifacts:directory}));
  } catch(error) {
    if(session){await capture("failure").catch(()=>{});const observed=await session.evaluate("({href:location.href,text:document.body.innerText,active:document.activeElement?.tagName})").catch(()=>null);await Deno.writeTextFile(`${directory}/failure.json`,JSON.stringify({error:String(error),observed,results,writes,events:session.events,errors:session.errors,server:server?.logs()},null,2));}
    throw error;
  } finally {await session?.close();await server?.close();await remote.close();}
}
