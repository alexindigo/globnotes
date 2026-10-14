// Feature-owned native Save/Delete -> real guard -> UI/API/disk/index consumers.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";

let options;
try { options = parseArguments(Deno.args); }
catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: plugin-guard-preservation.mjs --artifacts <directory>"); Deno.exit(0); }
if (!options.artifacts) { console.error("--artifacts is required"); Deno.exit(2); }
const artifacts = options.artifacts;
await Deno.mkdir(artifacts, { mode: 0o700 });
const outcomes = [];
const seed = "Guard seed.\n\n[attachment](asset.bin)\n";
const bytes = new Uint8Array([0, 1, 2, 65, 66, 255]);
const assert = (value, message) => { if (!value) throw Error(message); };
let current, failure;
const api = async (path, options = {}) => {
  const response = await fetch(`${current.server.baseUrl}/_/api/${path}`, { ...options, signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text };
};
async function wait(predicate) {
  const end = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= end) throw Error("Native mutation-response observation deadline");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function capture(label) {
  const { data } = await current.session.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${current.directory}/${label}.png`, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { createNew: true });
  await Deno.writeTextFile(`${current.directory}/${label}.json`, JSON.stringify(await current.session.evaluate("({url:location.href,body:document.body.innerText,buffer:document.querySelector('.cm-content')?.textContent,top:document.querySelector('[data-modal-top=true]')?.getBoundingClientRect().toJSON()})"), null, 2), { createNew: true });
}
async function setup(label) {
  assert(!current || current.closed, "Previous successful guard fixture still owns resources");
  const directory = `${artifacts}/${label}`;
  await Deno.mkdir(directory);
  const vault = await Deno.makeTempDir({ prefix: `gps05-${label}-vault-` });
  const state = await Deno.makeTempDir({ prefix: `gps05-${label}-state-` });
  await Deno.writeTextFile(`${vault}/NoteA.md`, seed);
  await Deno.writeFile(`${vault}/asset.bin`, bytes);
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: "none" }));
  for (const [id, hooks] of [["native-guard", ["pre-save", "pre-delete"]], ["native-observer", ["on-save"]]]) {
    await Deno.mkdir(`${state}/plugins/${id}`, { recursive: true });
    await Deno.writeTextFile(`${state}/plugins/${id}/manifest.json`, JSON.stringify({ id, runtime: { server: "service.js" }, hooks, settings: [{ id: "preferences", label: id === "native-guard" ? "Guard preferences" : "Observer preferences", renderer: { kind: "declarative-v1", version: 1 }, fields: [{ key: "enabled", label: "Enabled preference", type: "toggle", default: true }] }] }));
    await Deno.writeTextFile(`${state}/plugins/${id}/service.js`, id === "native-guard"
      ? "let saves=0,deletes=0;export function activate(ctx){ctx.hooks.on('pre-save',()=>{saves++;return {cancel:true,reason:'GPS05 native Save protection'};});ctx.hooks.on('pre-delete',()=>{deletes++;return {cancel:true,reason:'GPS05 native Delete protection'};});ctx.commands.register({id:'counts',label:'Guard counts',target:'server'},()=>({saves,deletes}));}"
      : "let saves=0;export function activate(ctx){ctx.hooks.on('on-save',()=>{saves++;});ctx.commands.register({id:'counts',label:'Observer counts',target:'server'},()=>({saves}));}");
  }
  const server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "" }, logsDir: directory });
  const session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9333) });
  current = { label, directory, vault, state, server, session, requests: [], responses: [], navigation: [], closed: false };
  await Deno.writeTextFile(`${directory}/ownership.json`, JSON.stringify({ label, vault, state, serverPid: server.pid, baseUrl: server.baseUrl, targetId: session.targetId, browserContextId: session.browserContextId }, null, 2), { createNew: true });
  const requestIds = new Set();
  session.page.onEvent(event => {
    // GPS05_RETENTION_DIAGNOSTIC: passive URL observation; no input/state changes.
    if (event.method === "Page.navigatedWithinDocument") current.navigation.push({ ...event.params, observedAt: Date.now() });
    if (event.method === "Network.requestWillBeSent" && ["PATCH", "DELETE"].includes(event.params.request.method) && new URL(event.params.request.url).pathname === "/_/api/notes/NoteA") {
      requestIds.add(event.params.requestId);
      current.requests.push({ requestId: event.params.requestId, method: event.params.request.method, url: event.params.request.url, body: event.params.request.postData });
    }
    if (event.method === "Network.responseReceived" && requestIds.has(event.params.requestId)) current.responses.push({ requestId: event.params.requestId, status: event.params.response.status });
  });
  await session.goto(`${server.baseUrl}/NoteA`); await session.poll("!!document.querySelector('.toast-viewer')");
  await session.evaluate("document.fonts.ready.then(()=>true)");
  current.originalNote = await api("notes/NoteA");
  current.originalIndex = await api("note-index");
  assert(current.originalIndex.body.some(note => note.path === "NoteA"), "Guard fixture note absent from actual index");
  await session.button("Edit", ".content-column"); await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
}
async function badges() {
  const { session } = current;
  await session.click('[title="Open sidebar"]'); await session.click('[aria-label="Settings"]'); await session.poll("!!document.querySelector('#settings-modal-title')");
  await session.button("Plugins");
  await session.poll("!!document.querySelector('[data-plugin-inventory-id=native-guard]') && !!document.querySelector('[data-plugin-inventory-id=native-observer]')");
  assert(await session.evaluate("document.querySelector('[data-plugin-inventory-id=native-guard]').textContent.includes('Can block actions') && document.querySelector('[data-plugin-inventory-id=native-guard]').textContent.includes('delete') && !document.querySelector('[data-plugin-inventory-id=native-observer]').textContent.includes('Can block actions')"), "Blocking inventory badges do not distinguish pre/on-only plugins");
  await capture("only-pre-inventory-badge");
  await session.button("Guard preferences"); await session.poll("!!document.querySelector('#settings-field-enabled')");
  assert(await session.evaluate("document.querySelector('[data-modal-top=true]').textContent.includes('Can block actions') && document.querySelector('[data-modal-top=true]').textContent.includes('Errors or timeouts')"), "Actual guard page omitted blocking consequence");
  await capture("guard-page-badge");
  await session.button("Observer preferences"); await session.poll("!!document.querySelector('#settings-field-enabled')");
  assert(await session.evaluate("!document.querySelector('[data-modal-top=true]').textContent.includes('Can block actions')"), "On-only declarative page gained blocking badge");
  await capture("observer-page-no-blocking-badge");
  await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')");
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
}
async function mark() {
  const { session } = current;
  current.before = await session.evaluate("({url:location.href,buffer:document.querySelector('.cm-content').textContent,folder:document.querySelector('input[placeholder=\"Folder (root)\"]').value,title:document.querySelector('input[placeholder=Title]').value})");
  await session.evaluate("window.__gps05Editor=document.querySelector('.cm-content');true");
  // GPS05_RETENTION_DIAGNOSTIC: persist the actual admitted baseline, not a guess.
  await Deno.writeTextFile(`${current.directory}/before-native-operation.json`, JSON.stringify({ ...current.before, observedAt: Date.now(), navigation: current.navigation }, null, 2), { createNew: true });
}
async function response() {
  await wait(() => current.responses.length === 1);
  const observed = current.responses[0];
  const body = await current.session.send("Network.getResponseBody", { requestId: observed.requestId });
  const result = { ...observed, body: JSON.parse(body.base64Encoded ? atob(body.body) : body.body) };
  await Deno.writeTextFile(`${current.directory}/actual-native-response.json`, JSON.stringify({ requests: current.requests, response: result }, null, 2), { createNew: true });
  assert(result.status === 409 && result.body.code === "plugin_cancelled" && result.body.pluginId === "native-guard", "Native guard response lacks actual cancellation identity");
  return result;
}
async function retained(result) {
  const { session, before, vault } = current;
  // GPS05_RETENTION_DIAGNOSTIC: identify first divergent value before asserting.
  const after = await session.evaluate("({url:location.href,buffer:document.querySelector('.cm-content').textContent,folder:document.querySelector('input[placeholder=\"Folder (root)\"]').value,title:document.querySelector('input[placeholder=Title]').value,sameEditor:document.querySelector('.cm-content')===window.__gps05Editor})");
  await Deno.writeTextFile(`${current.directory}/retention-comparison.json`, JSON.stringify({ before, after, equal: Object.fromEntries(Object.keys(before).map(key => [key, before[key] === after[key]])), observedAt: Date.now(), navigation: current.navigation }, null, 2), { createNew: true });
  assert(await session.evaluate(`location.href===${JSON.stringify(before.url)} && document.querySelector('.cm-content')===window.__gps05Editor && document.querySelector('.cm-content').textContent===${JSON.stringify(before.buffer)} && document.querySelector('input[placeholder="Folder (root)"]').value===${JSON.stringify(before.folder)} && document.querySelector('input[placeholder=Title]').value===${JSON.stringify(before.title)}`), "Cancelled native operation changed URL/editor/buffer/path intent");
  assert(JSON.stringify(await api("notes/NoteA")) === JSON.stringify(current.originalNote), "Cancelled operation changed note API");
  assert(await Deno.readTextFile(`${vault}/NoteA.md`) === seed, "Cancelled operation changed exact note disk bytes");
  assert(JSON.stringify(await api("note-index")) === JSON.stringify(current.originalIndex), "Cancelled operation changed actual note index");
  assert(JSON.stringify([...await Deno.readFile(`${vault}/asset.bin`)]) === JSON.stringify([...bytes]), "Cancelled operation changed attachment bytes");
  let destination = false;
  try { await Deno.stat(`${vault}/Destination`); destination = true; }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
  assert(!destination, "Cancelled operation created the destination directory or moved an attachment");
  const command = id => api(`plugin-host/${id}/commands/counts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const guard = await command("native-guard"), observer = await command("native-observer");
  const catalog = await api("plugin-host");
  await Deno.writeTextFile(`${current.directory}/actual-guard-observer-status.json`, JSON.stringify({ guard, observer, plugins: catalog.body.plugins.filter(plugin => ["native-guard", "native-observer"].includes(plugin.id)) }, null, 2), { createNew: true });
  assert(guard.status === 200 && observer.status === 200, `Actual guard/observer count consumer unavailable: ${guard.status}/${observer.status}`);
  assert(observer.body.result.saves === 0 && guard.body.result[current.label === "save" ? "saves" : "deletes"] === 1, "Cancelled operation skipped guard or ran after-save observer");
  await Deno.writeTextFile(`${current.directory}/retention.json`, JSON.stringify({ before, response: result, exactNoteApiDiskIndexAndAttachmentsRetained: true, noDestinationDirectory: true, guard: guard.body.result, observer: observer.body.result }, null, 2), { createNew: true });
}
async function finish() {
  assert(!current.session.errors.length, "Native guard probe page exception");
  await capture("outcome");
  await Deno.writeTextFile(`${current.directory}/consumers.json`, JSON.stringify({ label: current.label, passed: true, nativeReasonVisible: true, exactRetention: true, onlyPreBlockingBadges: true, pageErrors: current.session.errors, events: current.session.events }, null, 2), { createNew: true });
  await current.session.close(); await current.server.close(); current.closed = true;
  await Deno.writeTextFile(`${current.directory}/closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true }), { createNew: true });
  outcomes.push({ name: current.label, passed: true }); console.log(`ok: native ${current.label} reason and exact guard preservation`);
}
try {
  await setup("save"); await badges();
  await current.session.click(".cm-content"); await current.session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await current.session.type("GPS05 retained unsaved buffer\n\n[attachment](asset.bin)\n");
  await current.session.click('input[placeholder="Folder (root)"]'); await current.session.type("Destination");
  // GPS05_RETENTION_DIAGNOSTIC: no-Save control observes native caret URL first.
  const immediate = await current.session.evaluate("({url:location.href,buffer:document.querySelector('.cm-content').textContent})");
  await current.session.poll("location.hash==='#source:L4'");
  const settled = await current.session.evaluate("({url:location.href,buffer:document.querySelector('.cm-content').textContent})");
  const beforeControl = await api("plugin-host/native-guard/commands/counts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert(current.requests.length === 0 && beforeControl.body.result.saves === 0 && beforeControl.body.result.deletes === 0 && immediate.buffer === settled.buffer, "No-Save caret control executed an operation or changed the buffer");
  assert(JSON.stringify(await api("notes/NoteA")) === JSON.stringify(current.originalNote) && JSON.stringify(await api("note-index")) === JSON.stringify(current.originalIndex), "No-Save caret control changed note/index");
  await Deno.writeTextFile(`${current.directory}/no-save-caret-control.json`, JSON.stringify({ immediate, settled, nativeMutations: current.requests.length, guard: beforeControl.body.result, noteAndIndexUnchanged: true, navigation: current.navigation }, null, 2), { createNew: true });
  await mark(); await current.session.button("Save", ".content-column");
  await current.session.poll("!!document.querySelector('#rename-assets-title')");
  await current.session.click('[data-modal-top=true] button:first-of-type');
  const save = await response(); await retained(save);
  await current.session.poll("document.body.innerText.includes('GPS05 native Save protection') && document.body.innerText.includes('Blocked by plugin') && document.querySelector('[data-note-save-status]')?.textContent.includes('paused')");
  assert(await current.session.evaluate("typeof window.onbeforeunload==='function'"), "Cancelled Save lost dirty unload protection");
  await finish();
  await setup("delete"); await badges(); await mark();
  await current.session.button("Delete", ".content-column"); await current.session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Confirm Deletion')");
  await current.session.button("Delete", '[data-modal-top="true"]');
  const deletion = await response();
  await current.session.poll("document.body.innerText.includes('GPS05 native Delete protection') && document.body.innerText.includes('Blocked by plugin')");
  await retained(deletion);
  await finish();
  assert(outcomes.length === 2, "Missing native Save/Delete preservation case");
  console.log("GPS-05 GUARD PRESERVATION OK");
} catch (error) {
  failure = error;
  console.error(`FAIL: ${error.message}`);
  if (current && !current.closed) await capture("failure").catch(captureError => console.error(captureError.message));
}
await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({ outcomes, failure: failure?.message, ownership: current && { label: current.label, directory: current.directory, vault: current.vault, state: current.state, serverPid: current.server.pid, baseUrl: current.server.baseUrl, targetId: current.session.targetId, browserContextId: current.session.browserContextId }, pageErrors: current?.session.errors }, null, 2), { createNew: true });
if (failure) {
  if (current && !current.closed) {
    await current.session.close(); await current.server.close(); current.closed = true;
    await Deno.writeTextFile(`${current.directory}/failed-fixture-closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true, failureCapturedBeforeClosure: true, filesRetained: true }), { createNew: true });
  }
  throw failure;
}
