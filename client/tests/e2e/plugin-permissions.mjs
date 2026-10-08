// VM-only native operator consent. Each fixture/context and normal parent is owned.
import { nativeSession } from "./native-cdp-session.mjs";
import { parseArguments } from "./harness-helpers.mjs";

let options;
try { options = parseArguments(Deno.args); } catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: plugin-permissions.mjs --artifacts <directory>"); Deno.exit(0); }
if (!options.artifacts) { console.error("--artifacts is required"); Deno.exit(2); }
const ROOT = new URL("../../..", import.meta.url).pathname;
const artifacts = options.artifacts;
await Deno.mkdir(artifacts, { mode: 0o700 });
const assert = (value, detail) => { if (!value) throw Error(detail); };
const outcomes = [];
let current;

async function operatorSession() {
  const session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9333) });
  return { ...session, async button(text, scope = "body") {
    await session.poll(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(button=>button.textContent.trim()===${JSON.stringify(text)} && !button.disabled && !button.closest('[inert]') && button.getBoundingClientRect().width);if(!button)return false;button.scrollIntoView({block:'center',inline:'center'});const r=button.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button;})()`);
    return session.button(text, scope);
  } };
}

async function launch(fixture) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 }), port = listener.addr.port; listener.close();
  const args = ["run", "--unstable-worker-options", "--allow-net", "--allow-read", "--allow-write", "--allow-env",
    ...(fixture.importParent ? [`--allow-import=jsr.io:443,${fixture.authority}`, `--lock=${fixture.privateLock}`] : []), `${ROOT}/server/main.ts`];
  const child = new Deno.Command(Deno.execPath(), { args, cwd: ROOT, stdout: "piped", stderr: "piped", clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "", NO_COLOR: "1", GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_INDEX_PATH: fixture.state, GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_HOST: "127.0.0.1", GLOBNOTES_PORT: String(port) } }).spawn();
  const drains = ["stdout", "stderr"].map(async name => {
    const file = await Deno.open(`${fixture.directory}/server-${fixture.launchCount}-${name}.log`, { createNew: true, write: true });
    try { for await (const bytes of child[name]) { let at = 0; while (at < bytes.length) at += await file.write(bytes.subarray(at)); } } finally { file.close(); }
  });
  fixture.launchCount++;
  const base = `http://127.0.0.1:${port}`;
  await Deno.writeTextFile(`${fixture.directory}/parent-${fixture.launchCount}.json`, JSON.stringify({ pid: child.pid, args, cwd: ROOT, isolatedImportParent: fixture.importParent }, null, 2));
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const response = await fetch(`${base}/_/api/health`, { signal: AbortSignal.timeout(3000) }); await response.body?.cancel();
      if (response.ok) break;
    } catch { /* bounded owned startup */ }
    if (Date.now() > deadline) throw Error("Owned permission server health deadline");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (;;) {
    const response = await fetch(`${base}/_/api/plugin-host`, { signal: AbortSignal.timeout(3000) });
    const catalog = await response.json(), plugin = catalog.plugins.find(plugin => plugin.id === "networked");
    if (plugin?.status === "ready") break;
    if (plugin?.status === "failed" || Date.now() > deadline) throw Error(`Owned permission activation failed: ${JSON.stringify(plugin)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return { child, base, args, async close() { child.kill("SIGTERM"); await child.status; await Promise.all(drains); } };
}

async function fixture(name, { importParent = false, gateSaves = false, guardSaves = false } = {}) {
  const directory = `${artifacts}/${name}`; await Deno.mkdir(directory);
  const root = await Deno.makeTempDir({ prefix: "permissions-native-" }), vault = `${root}/vault`, state = `${root}/state`;
  await Deno.mkdir(vault); await Deno.mkdir(state); await Deno.writeTextFile(`${vault}/NoteA.md`, "Seed content.\n");
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: "none" }));
  let traffic = 0, moduleTraffic = 0, extraTraffic = 0, guardEntered = false;
  const guardRelease = Promise.withResolvers();
  const receiver = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async request => {
    if (new URL(request.url).pathname === "/module.js") { moduleTraffic++; return new Response("export const value='approved remote code'", { headers: { "content-type": "application/javascript" } }); }
    if (new URL(request.url).pathname === "/save-gate") { guardEntered = true; await guardRelease.promise; return new Response("guard released"); }
    traffic++; return new Response("approved native receiver");
  });
  const authority = `127.0.0.1:${receiver.addr.port}`;
  const extraReceiver = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => { extraTraffic++; return new Response("new unapproved scope"); });
  const extraAuthority = `127.0.0.1:${extraReceiver.addr.port}`;
  const dir = `${state}/plugins/networked`; await Deno.mkdir(dir, { recursive: true });
  const manifest = { id: "networked", name: "Networked mixed plugin", version: "1.0.0", runtime: { server: "service.js", client: "browser.js" }, client: { entry: "custom-editor.js" },
    ...(guardSaves ? { hooks: ["pre-save"] } : {}),
    capabilities: { network: [authority], imports: [authority], read: [], write: [] },
    settings: [{ id: "preferences", label: "Networked preferences", renderer: { kind: "declarative-v1", version: 1 }, fields: [{ key: "message", label: "Message", type: "text", default: "native" }, { key: "limit", label: "Limit", type: "number", default: 5, min: 1, max: 10 }] }] };
  await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(manifest));
  await Deno.writeTextFile(`${dir}/custom-editor.js`, "export default [];");
  await Deno.writeTextFile(`${dir}/browser.js`, "export function activate(ctx){ const nonce=crypto.randomUUID(); const marker=document.createElement('span');marker.dataset.permissionBrowserNonce=nonce;marker.hidden=true;document.body.append(marker);ctx.register(()=>marker.remove()); }");
  await Deno.writeTextFile(`${dir}/service.js`, `const instance=crypto.randomUUID();export async function activate(ctx){
    const request=await ctx.permissions.requestAccess({kind:'network',hosts:['${authority}'],reason:'Read native service status'});
    ${guardSaves ? `ctx.hooks.on('pre-save',async()=>{await(await fetch('http://${authority}/save-gate')).text();});` : ""}
    ctx.commands.register({id:'inspect',label:'Inspect networked',target:'server'},async()=>({instance,request,view:await ctx.permissions.status(),settings:await ctx.settings.read()}));
    ctx.commands.register({id:'fetch',label:'Fetch receiver',target:'server'},async()=>await(await fetch('http://${authority}/consumer')).text());
    ctx.commands.register({id:'import',label:'Import code',target:'server'},async()=>({value:(await import('http://${authority}/module.js')).value,net:Deno.permissions.querySync({name:'net',host:'${authority}'}).state,imports:Deno.permissions.querySync({name:'import',host:'${authority}'}).state}));
    ctx.commands.register({id:'request',label:'Request again',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['${authority}'],reason:'Read native service status'}));
    ctx.commands.register({id:'request-extra',label:'Request new scope',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['${extraAuthority}'],reason:'Read a newly discovered service'}));
    ctx.commands.register({id:'fetch-extra',label:'Fetch new scope',target:'server'},async()=>await(await fetch('http://${extraAuthority}/consumer')).text());
  }`);
  const unrelated = `${state}/plugins/unrelated`; await Deno.mkdir(unrelated, { recursive: true });
  await Deno.writeTextFile(`${unrelated}/manifest.json`, JSON.stringify({ id: "unrelated", runtime: { server: "service.js" } }));
  await Deno.writeTextFile(`${unrelated}/service.js`, "const instance=crypto.randomUUID();export function activate(ctx){ctx.commands.register({id:'inspect',label:'Inspect unrelated',target:'server'},()=>({instance}));}");
  const disabled = `${state}/plugins/disabled-editor`; await Deno.mkdir(disabled, { recursive: true });
  await Deno.writeTextFile(`${disabled}/manifest.json`, JSON.stringify({ id: "disabled-editor", name: "Disabled custom editor", client: { entry: "other-editor.js" }, runsInBrowser: false }));
  await Deno.writeTextFile(`${disabled}/other-editor.js`, "export default [];");
  await Deno.writeTextFile(`${state}/plugins.json`, JSON.stringify({ disabled: ["disabled-editor"] }));
  const value = { name, directory, root, vault, state, authority, receiver, extraReceiver, extraAuthority, importParent, privateLock: `${root}/import-control.lock`, launchCount: 0,
    traffic: () => traffic, moduleTraffic: () => moduleTraffic, extraTraffic: () => extraTraffic, sessions: [] };
  value.guardEntered = () => guardEntered; value.releaseGuard = guardRelease.resolve;
  if (importParent) await Deno.copyFile(`${ROOT}/deno.lock`, value.privateLock);
  current = value; value.server = await launch(value);
  value.noteWrites = [];
  if (gateSaves) {
    value.proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async request => {
      const url = new URL(request.url), mutation = ["POST", "PATCH"].includes(request.method) && /^\/_\/api\/notes(?:\/|$)/.test(url.pathname);
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
      const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
      const response = await fetch(`${value.server.base}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (!mutation) return new Response(response.body, { status: response.status, headers: response.headers });
      const bytes = await response.arrayBuffer(), held = Promise.withResolvers();
      value.noteWrites.push({ body: JSON.parse(new TextDecoder().decode(body)), backendStatus: response.status, released: held.promise, release: held.resolve });
      let timer;
      try { await Promise.race([held.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Owned dirty-note response deadline")), 30000); })]); }
      catch (error) {
        await Deno.writeTextFile(`${directory}/response-gate-deadline.json`, JSON.stringify({ detail: error.message, observedAt: Date.now(), completedWrites: value.noteWrites.length }, null, 2));
        // Deadline is observation, not permission to release/discard protected work.
        await held.promise;
      } finally { clearTimeout(timer); }
      return new Response(bytes, { status: response.status, headers: response.headers });
    });
  }
  value.entryBase = value.proxy ? `http://127.0.0.1:${value.proxy.addr.port}` : value.server.base;
  value.session = await operatorSession(); value.sessions.push(value.session);
  await value.session.goto(`${value.entryBase}/NoteA`);
  await value.session.poll("!!document.querySelector('.toast-viewer')");
  return value;
}
async function json(path, init) {
  const response = await fetch(`${current.server.base}/_/api/${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  const body = await response.json(); return { status: response.status, body };
}
const invoke = (id, command) => json(`plugin-host/${id}/commands/${command}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
async function view() { const result = await json("plugin-host/networked/permissions"); assert(result.status === 200, "permission GET rejected"); return result.body; }
async function committed(predicate, detail) {
  const end = Date.now() + 10000;
  for (;;) { const value = await view(); if (predicate(value)) return value; if (Date.now() > end) throw Error(`Permission commit deadline: ${detail}; ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function readyReload() {
  const end = Date.now() + 10000;
  for (;;) { const value = await view(); if (["none", "ready"].includes(value.reload.state)) return value; if (value.reload.state === "failed" || Date.now() > end) throw Error("affected server reload failed"); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function click(session, selector) { await session.poll(`!!document.querySelector(${JSON.stringify(selector)})`); await session.click(selector); }
async function dismissPrompt(session = current.session) {
  await session.poll("!!document.querySelector('#permission-request-title')");
  await session.button("Cancel", '[data-modal-top="true"]');
  await session.poll("!document.querySelector('#permission-request-title')");
}
async function inventory(session = current.session) {
  if (!await session.evaluate("!!document.querySelector('[aria-label=Settings]')?.getBoundingClientRect().width")) await click(session, '[title="Open sidebar"]');
  await session.poll("!!document.querySelector('[aria-label=Settings]')?.getBoundingClientRect().width");
  await click(session, '[aria-label="Settings"]'); await session.button("Plugins", '[aria-label="Settings pages"]');
  await session.poll("!!document.querySelector('[data-plugin-inventory-id=networked]')");
}
async function review(session = current.session) {
  await inventory(session);
  await session.button("Review permissions", '[data-plugin-inventory-id=networked]');
  await session.poll("!!document.querySelector('[data-permission-review] [data-plugin-permission-panel]')");
}
async function master(session = current.session) {
  const before = await view();
  await session.poll("[...document.querySelectorAll('[data-permission-review] button')].some(button=>button.textContent.trim()==='Allow network' && !button.disabled && !button.closest('[inert]') && button.getBoundingClientRect().width)");
  const admission = await session.evaluate("(()=>{const button=[...document.querySelectorAll('[data-permission-review] button')].find(button=>button.textContent.trim()==='Allow network');const r=button.getBoundingClientRect();return {disabled:button.disabled,pressed:button.getAttribute('aria-pressed'),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button};})()");
  assert(admission.hit && !admission.disabled, "master control not natively interactable at admission");
  await Deno.writeTextFile(`${current.directory}/master-admission-${before.revision}.json`, JSON.stringify(admission, null, 2));
  await session.button("Allow network", '[data-permission-review]');
  await committed(value => value.allowNetwork === !before.allowNetwork && value.revision > before.revision, "explicit master change"); await readyReload();
}
function rowSelector(kind) { return `[data-permission-review] [data-permission-kind=${kind}][data-permission-scope="host:${current.authority}"]`; }
async function closeReview(session = current.session) { await session.button("Close review", '[data-modal-top="true"]'); }
async function capture(label, session = current.session) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${current.directory}/${label}.png`, Uint8Array.from(atob(data), ch => ch.charCodeAt(0)));
  const geometry = await session.evaluate("({url:location.href,active:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('[role=dialog]')].map(el=>({title:el.getAttribute('aria-labelledby'),rect:el.getBoundingClientRect().toJSON(),inert:!!el.closest('[inert]')})),body:document.body.innerText})");
  await Deno.writeTextFile(`${current.directory}/${label}.json`, JSON.stringify(geometry, null, 2));
}
async function promptFocus(session = current.session) {
  await session.poll("document.querySelector('[data-modal-top=true] [role=dialog]')?.contains(document.activeElement)");
  const observations = [];
  for (let index = 0; index < 18; index++) {
    const state = await session.evaluate("(()=>{const mask=document.querySelector('[data-modal-top=true]'),dialog=mask.querySelector('[role=dialog]'),r=dialog.getBoundingClientRect();return {inside:dialog.contains(document.activeElement),focused:document.activeElement?.textContent?.trim()||document.activeElement?.getAttribute('type'),lowerInert:[...document.querySelectorAll('[data-modal-top=false]')].every(el=>el.inert),shellInert:document.querySelector('[data-app-shell]').inert,rect:r.toJSON(),contained:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};})()");
    assert(state.inside && state.lowerInert && state.shellInert && state.contained, "request focus/stack/viewport ownership failed");
    observations.push(state);
    if (index === 7) await capture("prompt-decisions", session);
    await session.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9 });
  }
  await Deno.writeTextFile(`${current.directory}/prompt-focus-geometry.json`, JSON.stringify(observations, null, 2));
}
async function outcome(marker, detail) { outcomes.push({ marker, detail, passed: true }); console.log(marker); await Deno.writeTextFile(`${artifacts}/outcomes.json`, JSON.stringify(outcomes, null, 2)); }
async function finish() {
  for (const session of current.sessions) { assert(!session.errors.length, "unexpected page exception"); await session.close(); }
  if (current.proxy) await current.proxy.shutdown();
  await current.server.close(); await current.receiver.shutdown(); await current.extraReceiver.shutdown(); current.closed = true;
}

try {
  await fixture("normal-parent");
  await current.session.poll("!!document.querySelector('#permission-request-title')");
  assert(current.traffic() === 0 && current.moduleTraffic() === 0, "request admission performed unapproved traffic");
  const initial = await invoke("networked", "inspect"); assert(initial.status === 200 && initial.body.result.request.status === "pending", "local activation did not finish before consent");
  await promptFocus();
  await capture("pending-request");
  await outcome("PERMISSIONS-02 DECLARE REQUEST OK", { request: initial.body.result.request, traffic: current.traffic(), modules: current.moduleTraffic() });
  // Cancel is defer; a declaration/equivalent request must not reopen this ID.
  await dismissPrompt(); await invoke("networked", "request");
  await review();
  assert(await current.session.evaluate("document.querySelector('[data-plugin-inventory] [data-plugin-trust-notice]')?.textContent.includes('server Workers only')"), "inventory trust boundary missing");
  assert(await current.session.evaluate("!!document.querySelector('[data-plugin-inventory-id=disabled-editor] [data-plugin-browser-badge]')"), "disabled custom editor badge missing");
  await capture("inventory-review");
  await outcome("PERMISSIONS-01 INVENTORY TRUST OK", { disabledCustomBadge: true, reviewNotice: true });
  const unrelated = (await invoke("unrelated", "inspect")).body.result.instance;
  const browserNonce = await current.session.evaluate("document.querySelector('[data-permission-browser-nonce]')?.dataset.permissionBrowserNonce");
  assert(browserNonce, "actual browser runtime marker missing");
  await current.session.button("Approve", rowSelector("network"));
  let value = await committed(value => value.approvedNetwork.length === 1, "network approval"); assert(value.allowNetwork === false && !value.effectiveNetwork.length, "approval implicitly enabled master");
  await master();
  const fetched = await invoke("networked", "fetch"); assert(fetched.status === 200 && fetched.body.result === "approved native receiver" && current.traffic() === 1, "native approval did not reach data receiver");
  const importDenied = await invoke("networked", "import"); assert(importDenied.status === 500 && current.moduleTraffic() === 0, "network consent approved imports");
  assert((await invoke("unrelated", "inspect")).body.result.instance === unrelated, "unrelated server owner replaced");
  assert(await current.session.evaluate(`document.querySelector('[data-permission-browser-nonce]')?.dataset.permissionBrowserNonce === ${JSON.stringify(browserNonce)}`), "browser owner replaced by server consent");
  await outcome("PERMISSIONS-03 NETWORK ONLY OK", { traffic: current.traffic(), moduleTraffic: current.moduleTraffic(), unrelated, browserNonce });
  await master(); value = await view(); assert(!value.allowNetwork && value.approvedNetwork.length === 1, "off discarded approval");
  assert((await invoke("networked", "fetch")).status === 500 && current.traffic() === 1, "off retained raw authority");
  await master(); assert((await invoke("networked", "fetch")).status === 200 && current.traffic() === 2, "on did not restore remembered requested approval");
  await current.session.button("Delete approval", rowSelector("network")); await committed(value => !value.approvedNetwork.length, "delete approval"); await readyReload(); value = await view();
  assert(!value.approvedNetwork.length && value.rows.some(row => row.kind === "network" && row.requested && !row.approved), "delete lost request or retained approval");
  assert((await invoke("networked", "fetch")).status === 500 && current.traffic() === 2, "delete failed to revoke traffic");
  await current.session.button("Approve", rowSelector("imports")); await committed(value => value.approvedImports.length === 1, "import approval"); await readyReload(); value = await view();
  assert(value.approvedImports.length === 1 && !value.effectiveImports.length && value.rows.some(row => row.kind === "imports" && row.blockedReasons.includes("parent-unavailable")), "missing parent displayed as effective");
  assert((await invoke("networked", "import")).status === 500 && current.moduleTraffic() === 0, "missing parent import executed");
  await capture("parent-unavailable");
  await outcome("PERMISSIONS-06 PARENT UNAVAILABLE OK", { rememberedImports: value.approvedImports, moduleTraffic: 0, normalArgs: current.server.args });
  await current.session.button("Approve", rowSelector("network")); await committed(value => value.approvedNetwork.length === 1, "restored network approval"); await readyReload();
  const beforeRestart = await view();
  await closeReview();
  const extraRequest = await invoke("networked", "request-extra");
  assert(extraRequest.status === 200 && extraRequest.body.result.status === "pending", "new scope silently approved");
  await current.session.poll("!!document.querySelector('#permission-request-title')");
  assert((await invoke("networked", "fetch-extra")).status === 500 && current.extraTraffic() === 0, "remembered approval covered new authority");
  await current.session.button("Deny", '[data-modal-top="true"]');
  await current.session.poll("!document.querySelector('#permission-request-title')");
  const deniedAgain = await invoke("networked", "request-extra");
  assert(deniedAgain.body.result.status === "denied" && deniedAgain.body.result.requestId === extraRequest.body.result.requestId, "equivalent denied request reopened");
  value = await view();
  assert(value.allowNetwork && JSON.stringify(value.approvedNetwork) === JSON.stringify(beforeRestart.approvedNetwork) && !value.approvedNetwork.some(scope => scope.authority === current.extraAuthority), "Deny changed unrelated consent or master");
  assert((await invoke("networked", "fetch-extra")).status === 500 && current.extraTraffic() === 0, "Deny allowed receiver traffic");
  await outcome("PERMISSIONS-04 DELETE MASTER OK", { traffic: current.traffic(), requestedStillVisible: true, newAuthority: current.extraAuthority, extraTraffic: current.extraTraffic(), terminalDeniedId: deniedAgain.body.result.requestId });
  const second = await operatorSession(); current.sessions.push(second);
  await second.goto(`${current.server.base}/NoteA`); await second.poll("!!document.querySelector('.toast-viewer')");
  if (await second.evaluate("!!document.querySelector('#permission-request-title')")) await dismissPrompt(second);
   await review(second);
   await second.poll(`document.querySelector(${JSON.stringify(rowSelector("network"))})?.textContent.includes('Approved — effective')`);
   assert(await second.evaluate(`document.querySelector('[data-permission-kind=network][data-permission-scope="host:${current.extraAuthority}"]')?.textContent.includes('Unapproved')`), "second context lost denied new-scope intent");
  await closeReview(second);
  await current.server.close(); current.server = await launch(current);
  value = await view(); assert(JSON.stringify(value.approvedNetwork) === JSON.stringify(beforeRestart.approvedNetwork) && value.allowNetwork, "approval did not survive normal server restart");
  assert((await invoke("networked", "fetch")).status === 200, "restarted approved consumer denied");
  await outcome("PERMISSIONS-05 RESTART TWO CONTEXTS OK", { storedNetwork: value.approvedNetwork, contextA: current.session.browserContextId, contextB: second.browserContextId });
  // Verify no browser isolation/badge suppression: the metadata remains despite master off.
  await current.session.goto(`${current.server.base}/NoteA`); await current.session.poll("!!document.querySelector('.toast-viewer')");
  await review(); await master();
  assert(await current.session.evaluate("!!document.querySelector('[data-permission-review] [data-plugin-browser-badge]') && document.querySelector('[data-permission-review] [data-plugin-trust-notice]').textContent.includes('Browser/editor plugin code')"), "master off hid browser trust metadata");
  await outcome("PERMISSIONS-08 BROWSER TRUST OK", { masterOff: true, badgeVisible: true });
  await finish();
  await fixture("isolated-import-parent", { importParent: true }); await dismissPrompt(); await review();
  await current.session.button("Approve", rowSelector("imports")); await committed(value => value.approvedImports.length === 1, "isolated import approval"); await master();
  const imported = await invoke("networked", "import"); assert(imported.status === 200 && imported.body.result.value === "approved remote code" && imported.body.result.imports === "granted" && imported.body.result.net !== "granted", "native isolated import consent did not reach module consumer independently");
  assert((await invoke("networked", "fetch")).status === 500 && current.traffic() === 0, "import consent granted raw network");
  await Deno.writeTextFile(`${current.directory}/import-consumer.json`, JSON.stringify({ imported: imported.body.result, moduleTraffic: current.moduleTraffic(), rawTraffic: current.traffic(), parentArgs: current.server.args }, null, 2));
  await capture("approved-import");
  await finish();
  await fixture("dirty-note-settings", { gateSaves: true }); await dismissPrompt();
  await current.session.button("Edit", ".content-column"); await current.session.button("Source", ".content-column");
  const typeNote = async text => {
    await current.session.click('.cm-content[contenteditable=true]');
    await current.session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await current.session.type(text);
    await current.session.poll(`document.querySelector('.cm-content')?.textContent.includes(${JSON.stringify(text)})`);
  };
  const write = async index => {
    const end = Date.now() + 10000;
    while (!current.noteWrites[index]) { if (Date.now() > end) throw Error("real dirty-note write not reached"); await new Promise(resolve => setTimeout(resolve, 20)); }
    return current.noteWrites[index];
  };
  await typeNote("PERMISSION-A"); await current.session.button("Save", ".content-column"); await write(0);
  await typeNote("PERMISSION-B"); await current.session.button("Save", ".content-column"); await typeNote("PERMISSION-D");
  // CodeMirror's owned cursor-line URL update must settle before the URL baseline.
  await current.session.poll("location.hash === '#source:L1'");
  await current.session.evaluate("window.__permissionEditor = document.querySelector('.cm-content'); window.__permissionUrl = location.href; true");
  const oldWorker = (await invoke("networked", "inspect")).body.result.instance;
  const oldOther = (await invoke("unrelated", "inspect")).body.result.instance;
  const oldBrowser = await current.session.evaluate("document.querySelector('[data-permission-browser-nonce]')?.dataset.permissionBrowserNonce");
  await inventory(); await current.session.button("Networked preferences", '[aria-label="Settings pages"]');
  await current.session.poll("!!document.querySelector('input[type=number]') && !document.querySelector('input[type=number]').readOnly && !document.querySelector('input[type=number]').disabled");
  await current.session.click('input[type=number]'); await current.session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await current.session.key("Backspace", { code: "Backspace", windowsVirtualKeyCode: 8 });
  await current.session.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9 });
  await current.session.poll("document.body.textContent.includes('Enter a number')");
  await current.session.button("Review permissions", '[data-modal-top="true"]');
  await current.session.button("Review access request", '[data-permission-review]');
  await current.session.poll("!!document.querySelector('#permission-request-title')");
  await promptFocus();
  await current.session.key("Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
  await current.session.poll("!document.querySelector('#permission-request-title') && !!document.querySelector('[data-permission-review]')");
  await current.session.poll("document.activeElement?.textContent.trim() === 'Review access request' && !!document.activeElement.closest('[data-modal-top=true]')");
  assert(await current.session.evaluate("document.querySelector('.cm-content') === window.__permissionEditor && location.href === window.__permissionUrl && document.querySelector('.cm-content').textContent.includes('PERMISSION-D')"), "prompt Escape lost editor/URL/live D");
  assert(current.noteWrites.length === 1, "permission review dispatched queued B before A acknowledgement");
  await current.session.button("Review access request", '[data-permission-review]');
  await current.session.button("Allow network", '[data-permission-request-choices]');
  await current.session.button("Approve selected request", '[data-modal-top="true"]');
  await current.session.poll("!document.querySelector('#permission-request-title')"); await readyReload();
  assert((await invoke("networked", "inspect")).body.result.instance !== oldWorker, "affected server owner did not replace");
  assert((await invoke("unrelated", "inspect")).body.result.instance === oldOther, "unrelated server replaced over dirty work");
  assert(await current.session.evaluate(`document.querySelector('[data-permission-browser-nonce]')?.dataset.permissionBrowserNonce === ${JSON.stringify(oldBrowser)} && document.querySelector('.cm-content') === window.__permissionEditor`), "server permission replaced browser/editor owner");
  assert((await invoke("networked", "fetch")).status === 200 && current.traffic() === 1, "dirty-work native approval did not reach receiver");
  await closeReview();
  assert(await current.session.evaluate("document.querySelector('input[type=number]')?.value === '' && document.body.textContent.includes('Enter a number')"), "permission reload erased invalid settings draft");
  await capture("dirty-settings-retained");
  current.noteWrites[0].release(); await write(1); current.noteWrites[1].release();
  await current.session.poll("!document.querySelector('.content-column .animate-spin')");
  const actual = await json("notes/NoteA"), disk = await Deno.readTextFile(`${current.vault}/NoteA.md`);
  assert(actual.status === 200 && disk === actual.body.content && disk.includes("PERMISSION-B") && !disk.includes("PERMISSION-D"), "A/B FIFO did not reach API/disk B exactly");
  assert(current.noteWrites.map(record => record.body.newContent).join('|') === "PERMISSION-A|PERMISSION-B", "permission flow changed A/B snapshots");
  assert(await current.session.evaluate("document.querySelector('.cm-content') === window.__permissionEditor && location.href === window.__permissionUrl && document.querySelector('.cm-content').textContent.includes('PERMISSION-D') && typeof window.onbeforeunload === 'function'"), "final approval/FIFO acknowledgement lost current D or protection");
   const dirtyWork = { apiDisk: disk, literalRequests: current.noteWrites.map(record => record.body.newContent), protectedLiveD: true, settingsInvalidDraft: true, oldWorker, oldOther, oldBrowser };
   await finish();
   await fixture("guard-reload-interruption", { gateSaves: true, guardSaves: true }); await dismissPrompt(); await review();
   await current.session.button("Approve", rowSelector("network")); await committed(value => value.approvedNetwork.length === 1, "guard network approval"); await master();
   await closeReview(); await current.session.key("Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
   await current.session.poll("!document.querySelector('#settings-modal-title')");
   await click(current.session, '[title="Close sidebar"]');
   await current.session.poll("!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width");
   await current.session.button("Edit", ".content-column"); await current.session.button("Source", ".content-column");
   await typeNote("GUARD-PERMISSION-A"); await current.session.button("Save", ".content-column");
   const guardDeadline = Date.now() + 10000;
   while (!current.guardEntered()) { if (Date.now() > guardDeadline) throw Error("real pre-save guard did not enter"); await new Promise(resolve => setTimeout(resolve, 20)); }
   assert(current.noteWrites.length === 0 && await Deno.readTextFile(`${current.vault}/NoteA.md`) === "Seed content.\n", "guard wait already changed storage");
   await typeNote("GUARD-PERMISSION-B"); await current.session.button("Save", ".content-column"); await typeNote("GUARD-PERMISSION-D");
   await current.session.poll("location.hash === '#source:L1'");
   await current.session.evaluate("window.__guardEditor=document.querySelector('.cm-content');window.__guardUrl=location.href;true");
   await review(); await master();
   const rejectedSave = await write(0);
   assert(rejectedSave.backendStatus === 503, "permission revocation did not reject the old required guard");
   rejectedSave.release(); current.releaseGuard();
   await current.session.poll("document.querySelector('[data-note-save-status]')?.textContent.includes('Saving paused') && !document.querySelector('.content-column .animate-spin')");
   await closeReview(); await current.session.key("Escape", { code: "Escape", windowsVirtualKeyCode: 27 });
   await current.session.poll("!document.querySelector('#settings-modal-title')");
   await click(current.session, '[title="Close sidebar"]');
   await current.session.poll("!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width");
   assert(current.noteWrites.length === 1 && rejectedSave.body.newContent === "GUARD-PERMISSION-A", "guard interruption dispatched held B or changed A");
   const untouched = await json("notes/NoteA");
   assert(untouched.body.content === "Seed content.\n" && await Deno.readTextFile(`${current.vault}/NoteA.md`) === untouched.body.content, "interrupted guard changed API/disk");
   assert(await current.session.evaluate("document.querySelector('.cm-content')===window.__guardEditor && location.href===window.__guardUrl && document.querySelector('.cm-content').textContent.includes('GUARD-PERMISSION-D') && typeof window.onbeforeunload==='function' && document.querySelector('[data-note-save-status]').textContent.includes('1 held saves')"), "guard interruption lost protected work or reported saved success");
   await capture("guard-rejection-retained");
   await outcome("PERMISSIONS-07 DIRTY WORK OK", { ...dirtyWork, guardInterruption: { status: rejectedSave.backendStatus, persisted: untouched.body.content, submitted: rejectedSave.body.newContent, heldB: true, protectedLiveD: true, sameEditorAndUrl: true } });
   await finish();
  assert(outcomes.length === 8 && outcomes.every(row => row.passed), "permission matrix incomplete");
  await Deno.writeTextFile(`${artifacts}/summary.json`, JSON.stringify({ outcomes, complete: true }, null, 2));
  console.log("PLUGIN PERMISSIONS UI OK");
} catch (error) {
   const metadata = current && { name: current.name, serverPid: current.server.child.pid, baseUrl: current.server.base, entryBase: current.entryBase, root: current.root, vault: current.vault, state: current.state,
    targetId: current.session.targetId, browserContextId: current.session.browserContextId, closed: !!current.closed };
  await Deno.writeTextFile(`${artifacts}/summary.json`, JSON.stringify({ outcomes, failure: error.stack, current: metadata }, null, 2));
  console.error(`Retained permissions failure: ${error.message}; ${artifacts}/summary.json`);
  for (;;) await new Promise(resolve => setTimeout(resolve, 1000));
}
