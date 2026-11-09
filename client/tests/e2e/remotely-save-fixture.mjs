// Production plugin, ordinary controls, actual Worker/hub/disk and native input.
// CI uses a deterministic HTTP peer; the interop wrapper supplies real services.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { remotelySaveRemote } from "../../../tests/helpers/remotely_save_remote.ts";
import { createCodec } from "../../../plugins/globnotes-remotely-save/crypto.js";
import { referenceCodecs, referenceStore } from "../../../tests/interop/remotely_save_reference.mjs";
import { applicationServer } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { finalizeNativeCase } from "./native-case-finalization.mjs";
import { settleSettingsInventory } from "./settings-inventory-native.mjs";
import { assert } from "./test-outcomes.mjs";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { readExportOwner, waitForDriverExport } from "./driver-export-owner.mjs";
import { DatabaseSync } from "node:sqlite";
export { assert };
export const until = (predicate, label) => waitUntil(async () => await predicate() ? done() : pending({label}), {label, intervalMs:50});
const utf8 = new TextEncoder(), text = new TextDecoder();
const password = "native-only-passphrase-canary";
const source = new URL("../../../plugins/globnotes-remotely-save/", import.meta.url);
const plugin = '[data-plugin-inventory-id="globnotes-remotely-save"]';

export async function remotelySaveCase(backend, mode, run) {
  assert(["s3", "webdav"].includes(backend) && ["none", "openssl-base64", "rclone-base64"].includes(mode), "Select one supported backend/codec workflow");
  const parent = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({prefix:"remotely-native-"});
  const real = Deno.env.get("RS_NATIVE_REAL") === "1";
  const upstream = real ? await referenceCodecs() : null;
  const reports = [];
  {
    const label = `${backend}-${mode}`;
    const directory = `${parent}/remotely-save-native/${label}`, vault = `${directory}/vault`, state = `${vault}/.globnotes`;
    await Deno.mkdir(`${state}/plugins/globnotes-remotely-save`, {recursive:true});
    for (const entry of Deno.readDirSync(source)) if (entry.isFile && (entry.name.endsWith(".js") || entry.name === "manifest.json")) {
      await Deno.copyFile(new URL(entry.name, source), `${state}/plugins/globnotes-remotely-save/${entry.name}`);
    }
    let server, session, peer, codec, error, exportControl;
    const results = [], packets = [];
    const captures = backend === "webdav" && ["none", "rclone-base64"].includes(mode);
    try {
      peer = real ? null : remotelySaveRemote(backend);
      const endpoint = real ? Deno.env.get(backend === "s3" ? "RS_S3_ENDPOINT" : "RS_DAV_ENDPOINT") : peer.url;
      assert(endpoint, "Real native case requires the feature-owned service wrapper");
      const prefix = real ? (backend === "s3" ? `native-${mode}` : `anonymous/native-${mode}`) : (backend === "s3" ? "prefix" : "base");
      const store = real ? referenceStore(backend, endpoint, prefix) : null;
      if (store) await store.initialize();
      codec = real ? await upstream(mode, password) : await createCodec(mode, password);
      const names = new Map();
      async function nativeName(path) {
        if (names.has(path)) return names.get(path);
        if (store) for (const item of await store.list()) {
          const decoded = await codec.decodeName(item.key);
          names.set(decoded, item.key);
        }
        if (!names.has(path)) names.set(path, real ? await codec.name(path) : await codec.encryptName(path));
        return names.get(path);
      }
      async function put(path, content) {
        const name = await nativeName(path), bytes = real ? await codec.encode(utf8.encode(content)) : await codec.encrypt(utf8.encode(content));
        if (store) await store.put(name, bytes); else peer.set(name, bytes);
        if(path === "Live.md" && exportControl?.armed) exportControl.release("external-write");
      }
      async function read(path) {
        const name = await nativeName(path);
        const bytes = store ? (await store.get(name)).bytes : peer.objects.get(name)?.bytes;
        return bytes ? text.decode(real ? await codec.decode(bytes) : await codec.decrypt(bytes)) : null;
      }
      await Deno.writeTextFile(`${vault}/Collision.md`, "local collision\n");
      await put("Collision.md", "remote collision\n");
      await put("Live.md", "first\n\nlast\n");
      server = await bootServer({GLOBNOTES_PATH:vault,GLOBNOTES_INDEX_PATH:state,GLOBNOTES_AUTH_TYPE:"none",GLOBNOTES_AUTO_ENABLE_PLUGINS:"false"}, applicationServer());
      async function api(route, method="GET", body) {
        const response = await fetch(`${server.baseUrl}/_/api/${route}`, {method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
        const raw = await response.text(); packets.push(raw);
        assert(response.ok, `${method} ${route}: ${response.status} ${raw}`);
        return raw ? JSON.parse(raw) : null;
      }
      session = await nativeSession({port:Number(Deno.env.get("CDP_PORT") ?? 9335), width:1280, height:2200});
      await session.send("Emulation.setTimezoneOverride", {timezoneId:"America/Los_Angeles"});
      const s = session;
      const scope = '[data-driver-id="home"]';
      const f = {s,scope,label,directory,vault,state,results,api,put,read,captures,backend,mode,real,
        waitForExport:(path,content)=>waitForDriverExport(state,path,content,{onPending:owner=>exportControl?.release("unacknowledged-owner-observed",owner)}),
        async fill(selector, value) {
          await s.click(selector); await s.key("a", {modifiers:2,code:"KeyA",windowsVirtualKeyCode:65});
          await s.key("Backspace", {windowsVirtualKeyCode:8}); if (value) await s.type(value);
          assert(await s.read(selector, `document.querySelector(${JSON.stringify(selector)}).value`) === value, "Native field entry differs");
        },
        async select(selector, index, value) {
          await s.click(selector); await s.key("Home", {windowsVirtualKeyCode:36});
          for(let i=0;i<index;i++) await s.key("ArrowDown", {windowsVirtualKeyCode:40});
          await s.key("Enter", {windowsVirtualKeyCode:13});
          assert(await s.read(selector, `document.querySelector(${JSON.stringify(selector)}).value`) === JSON.stringify(value), "Native selection differs");
        },
        async controls() { await s.poll(`!!document.querySelector('${scope} .driver-instance__header [role=switch]') && !document.querySelector('[data-sync-settings] [aria-busy=true]')`); },
        async open(page="Sync") {
          if (!await s.read('[data-app-shell]', "!!document.querySelector('#settings-modal-title')")) {
            if (await s.read('[data-app-shell]', "!!document.querySelector('[title=\"Open sidebar\"]')")) await s.click('[title="Open sidebar"]');
            await s.click('[aria-label="Settings"]');
          }
          await s.button(page, '[role=dialog] nav');
          if(page === "Sync") await s.poll("!!document.querySelector('[data-sync-settings]') && !document.querySelector('[data-sync-settings]').textContent.includes('Loading sync settings...')");
        },
        async close() {
          await s.click('[aria-label="Close settings"]'); await s.poll("!document.querySelector('#settings-modal-title')");
          if(await s.read('[data-app-shell]', "!!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width")) await s.click('[title="Close sidebar"]');
        },
        async active() { await s.poll(`document.querySelector('${scope} .driver-instance__state')?.textContent==='Active'`); await f.controls(); },
        async sync() { await s.button("Sync now", scope); await f.controls(); },
        async key(name, value) {
          const input = `#driver-key-home-${name}`, section = `.driver-secret:has(${input})`;
          await f.fill(input, value);
          await s.button("Save key", section);
          await s.poll(`document.querySelector(${JSON.stringify(input)})?.value===''`); await f.controls();
          assert((await api("drivers")).instances[0].secrets.find(row=>row.key===name).set, "Key did not persist at its owner");
        },
        async capture(name) {
          if (!captures) return;
          if(name!=="key-entry") await s.evaluate("document.querySelector('[data-settings-content]')?.scrollTo({top:0}); true");
          await s.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
          const image = await s.send("Page.captureScreenshot", {format:"png",captureBeyondViewport:false});
          await Deno.writeFile(`${directory}/${name}.png`, Uint8Array.from(atob(image.data), c=>c.charCodeAt(0)));
          const regions = await s.read('[data-app-shell]', `(()=>{const output={};for(const [name,selector] of Object.entries({shell:'[data-app-shell]',frame:'[role=dialog]',navigation:'[role=dialog] nav',content:'[data-settings-content]',header:'.driver-instance__header',fields:'.driver-instance__settings',keys:'.driver-secret',editor:'.content-column',inbox:'.conflicts-page'})){const rows=[...document.querySelectorAll(selector)].map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height);if(!rows.length)continue;const x=Math.max(0,Math.min(...rows.map(r=>r.left))),y=Math.max(0,Math.min(...rows.map(r=>r.top))),right=Math.min(innerWidth,Math.max(...rows.map(r=>r.right))),bottom=Math.min(innerHeight,Math.max(...rows.map(r=>r.bottom)));if(right>x&&bottom>y)output[name]={x,y,width:right-x,height:bottom-y,scale:1};}return output;})()`);
          await Deno.mkdir(`${directory}/review`, {recursive:true});
          await Deno.writeTextFile(`${directory}/review/${name}.json`, JSON.stringify(regions,null,2));
          for (const [region,clip] of Object.entries(regions)) {
            const image = await s.send("Page.captureScreenshot", {format:"png",clip});
            await Deno.writeFile(`${directory}/review/${name}-${region}.png`, Uint8Array.from(atob(image.data), c=>c.charCodeAt(0)));
          }
        },
        async geometry(name) {
          const value = await s.read(['[role=dialog]', '[data-settings-content]',scope], `(()=>{const frame=document.querySelector('[role=dialog]'),column=document.querySelector('[data-settings-content]').getBoundingClientRect();return {overflow:frame.scrollWidth-frame.clientWidth,column:column.toJSON(),actions:[...document.querySelectorAll('${scope} button,${scope} input,${scope} select,${scope} textarea')].filter(el=>el.getBoundingClientRect().width).map(el=>el.getBoundingClientRect().toJSON()),labels:[...document.querySelectorAll('${scope} label')].map(el=>({text:el.textContent,for:el.htmlFor,rect:el.getBoundingClientRect().toJSON(),height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight),whiteSpace:getComputedStyle(el).whiteSpace})),centers:[...document.querySelectorAll('${scope} .driver-instance__header > *')].map(el=>{const r=el.getBoundingClientRect();return(r.top+r.bottom)/2;})};})()`);
          results.push({name,geometry:value});
          assert(value.overflow<=1, "Sync dialog overflow");
          assert(value.actions.every(r=>r.left>=value.column.left-1&&r.right<=value.column.right+1), "Control escaped Sync content");
          assert(value.labels.every(r=>r.whiteSpace==='nowrap'||r.height<=r.line+1), "Sync label wrapped");
          if(name==='desktop') assert(Math.max(...value.centers)-Math.min(...value.centers)<=1, "Header centerlines differ");
        },
        async rows(name) {
          const rows = await s.read(['[data-settings-content]', '.setting-row-short'], `(()=>{const column=document.querySelector('[data-settings-content]').getBoundingClientRect();return [...document.querySelectorAll('.setting-row-short')].map(row=>{const label=row.querySelector('.setting-row-label'),control=row.querySelector('.setting-row-control'),r=label.getBoundingClientRect(),c=control.getBoundingClientRect();return {text:label.textContent,label:r.toJSON(),control:c.toJSON(),column:column.toJSON(),line:parseFloat(getComputedStyle(label).lineHeight)};});})()`);
          results.push({name,rows});
          for(const row of rows) {
            assert(row.label.height<=row.line+1, "Shared row label wrapped");
            assert(row.control.left>=row.column.left-1&&row.control.right<=row.column.right+1, "Shared row control escaped column");
            const stacked=row.control.top>=row.label.bottom;
            assert(stacked||Math.abs((row.label.top+row.label.bottom-row.control.top-row.control.bottom)/2)<=1, "Shared row neither stacks nor aligns centers");
            if(name.endsWith('desktop')) assert(!stacked, "Desktop row did not retain its label/control pair");
            if(name==='sync-narrow'&&row.text==='Encryption') assert(stacked, "Wide select did not reflow below its label");
          }
        },
      };
      await s.goto(server.baseUrl + "/"); await f.open("Plugins");
      // Install copies exact shipped files; enablement and broad network consent
      // are explicit native gestures, with API read-back of the actual policy.
      await s.click(`${plugin} .plugin-row-actions [role=switch]`);
      await settleSettingsInventory(s, `document.querySelector('${plugin} .plugin-row-actions [role=switch]')?.getAttribute('aria-checked')==='true'`);
      await s.click(`${plugin} button.plugin-row-disclosure`);
      await s.button("Approve", `${plugin} [data-permission-kind=network]`);
      await s.button("Approve all hosts", '[data-modal-top=true]');
      await s.poll(`document.querySelector('${plugin} [data-permission-kind=network]')?.textContent.includes('Approved')`);
      await s.click(`${plugin} [data-plugin-permission-panel] [role=switch]`);
      await s.poll(`document.querySelector('${plugin} [data-plugin-permission-panel] [role=switch]')?.getAttribute('aria-checked')==='true'`);
      const permissions = await api("plugin-host/globnotes-remotely-save/permissions");
      assert(permissions.allowNetwork && permissions.effectiveNetwork.some(row=>row.type==='all') && !permissions.effectiveImports.length, "Explicit network-only consent not effective");
      await f.open(); await f.capture("empty");
      await s.button("Add", '[data-sync-settings]'); await f.fill("#sync-label", "Home"); await s.button("Add instance", '[data-sync-settings]'); await f.controls();
      await f.select("#driver-home-backend", backend==='s3'?0:1, backend);
      if(backend==='s3') {
        await f.fill("#driver-home-s3Endpoint", endpoint); await f.fill("#driver-home-s3Bucket", "bucket"); await f.fill("#driver-home-s3Prefix", prefix);
        await s.click("#driver-home-s3PathStyle");
      } else { await f.fill("#driver-home-webdavUrl", real?endpoint:endpoint+"/dav/"); await f.fill("#driver-home-webdavBaseDir", prefix); }
      await f.select("#driver-home-encryption", ["none","openssl-base64","rclone-base64"].indexOf(mode), mode);
      await s.button("Save settings", scope); await f.controls();
      const settings = (await api("drivers")).instances[0].settings;
      assert(settings.backend===backend&&settings.encryption===mode, "Displayed settings differ from persisted settings");
      if(backend==='s3') { await f.key("s3_access_key", "interop-access"); await f.key("s3_secret_key", "interop-secret"); }
      if(mode!=='none') {
        await s.click(`${scope} .driver-instance__header [role=switch]`);
        await s.poll(`document.querySelector('${scope} .driver-instance__state')?.textContent==='Locked'`);
        assert(!await Deno.stat(`${vault}/Live.md`).then(()=>true,e=>{if(e instanceof Deno.errors.NotFound)return false;throw e;}), "Missing encryption key imported content");
        await f.capture("locked");
        await f.fill("#driver-key-home-encryption_password", password); await f.capture("key-entry");
        await s.button("Save key", '.driver-secret:has(#driver-key-home-encryption_password)'); await f.controls();
      } else await s.click(`${scope} .driver-instance__header [role=switch]`);
      await f.active();
      // Opt-in causal control: verification cannot finish until the consumer
      // observes its pending owner or starts the next (premature) external write.
      if(!real&&backend==="webdav"&&mode==="none"&&Deno.env.get("RS_NATIVE_EXPORT_CONTROL")==="1"){
        const gate=Promise.withResolvers();const trace=[];
        exportControl={armed:false,released:false,trace,release(reason,owner){
          if(this.released)return;
          this.released=true;trace.push({event:reason,owner:owner??readExportOwner(state,"Live.md")});gate.resolve();
        }};
        peer.fault((request,key)=>{
          if(key==="Live.md"&&request.method==="PUT"){exportControl.armed=true;trace.push({event:"put-dispatched",owner:readExportOwner(state,"Live.md")});}
          if(key==="Live.md"&&request.method==="GET"&&exportControl.armed&&!exportControl.released){trace.push({event:"verification-held",owner:readExportOwner(state,"Live.md")});return gate.promise;}
        });
      }
      assert(await s.read(scope, `document.querySelector('${scope}').textContent.includes('This storage cannot check versions while writing; a change made there at the same moment can be overwritten.')`), "Emulation notice missing");
      await run(f);
      const storage = await s.read('[data-app-shell]', "JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookies:document.cookie})");
      for(const marker of [password,encodeURIComponent(password),btoa(password),"interop-secret"]) {
        assert(!storage.includes(marker)&&!packets.join('').includes(marker)&&!JSON.stringify(server.logs()).includes(marker), "Secret leaked outside its write-only owner");
      }
      assert(!s.errors.length, `Browser exceptions: ${JSON.stringify(s.errors)}`);
      reports.push({label,real,results,events:s.events});
    } catch(cause) { error=cause; throw cause; }
    finally {
      exportControl?.release("case-teardown");
      await finalizeNativeCase({error,
        report:async()=>{
          if(exportControl){
            const db=new DatabaseSync(`${state}/hub.sqlite`,{readOnly:true});
            try {await Deno.writeTextFile(`${directory}/export-control.json`,JSON.stringify({trace:exportControl.trace,owner:readExportOwner(state,"Live.md"),changes:db.prepare("SELECT seq,path,kind,peer,origin,before_hash,after_hash FROM changes ORDER BY seq").all(),conflicts:db.prepare("SELECT path,copy_path,reason,state FROM conflicts").all()},null,2));}finally{db.close();}
          }
          await Deno.writeTextFile(`${directory}/results.json`, JSON.stringify({label,real,error:error?String(error):null,results,events:session?.events,errors:session?.errors,server:server?.logs()},null,2));
          if(error&&session) {
            const image = await session.send("Page.captureScreenshot", {format:"png",captureBeyondViewport:false});
            await Deno.writeFile(`${directory}/failure.png`, Uint8Array.from(atob(image.data), c=>c.charCodeAt(0)));
            const observed=await session.read('body', "({href:location.href,text:document.body.innerText})");
            await Deno.writeTextFile(`${directory}/failure.json`,JSON.stringify(observed,null,2));
          }
        }, cleanup:[()=>session?.close(),()=>server?.close(),()=>peer?.close(),()=>codec?.dispose?.()],
      });
    }
  }
  await Deno.writeTextFile(`${parent}/remotely-save-native.json`, JSON.stringify(reports,null,2));
  assert(reports.length === 1, "Selected native workflow did not complete");
  console.log(JSON.stringify({case:"remotely-save-native",backend,mode,real,completed:reports.length}));
}
