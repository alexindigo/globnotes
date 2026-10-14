// Feature-owned, VM-only consumer proof. Each case owns a fresh browser context.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";

let options;
try { options = parseArguments(Deno.args); } catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: note-save-owner-guards.mjs --artifacts <directory>"); Deno.exit(0); }
if (!options.artifacts) { console.error("--artifacts is required"); Deno.exit(2); }
const artifacts = options.artifacts;
await Deno.mkdir(artifacts, { mode: 0o700 });
const outcomes = [];
let current, failure;
const assert = (condition, detail) => { if (!condition) throw new Error(detail); };
const wait = async predicate => {
  const end = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Owned transport deadline");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

async function setup(name, { view = false, readonly = false, create = false } = {}) {
  const directory = `${artifacts}/${name}`;
  await Deno.mkdir(directory);
  const vault = await Deno.makeTempDir({ prefix: "owner-guards-vault-" });
  const state = await Deno.makeTempDir({ prefix: "owner-guards-state-" });
  await Deno.writeTextFile(`${vault}/NoteA.md`, "Seed content.\n");
  await Deno.writeTextFile(`${vault}/Other.md`, "Other content.\n");
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: readonly ? "read_only" : "none" }));
  await Deno.mkdir(`${state}/plugins/owner-guard`, { recursive: true });
  await Deno.writeTextFile(`${state}/plugins/owner-guard/manifest.json`, JSON.stringify({ id: "owner-guard", runtime: { server: "service.js" }, hooks: ["pre-save"] }));
  await Deno.writeTextFile(`${state}/plugins/owner-guard/service.js`, "export function activate(ctx) { ctx.hooks.on('pre-save', fact => fact.proposed.content.includes('OWNER-GUARD') ? {cancel:true,reason:'Owned guard rejection'} : {cancel:false}); }");
  const server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "" }, logsDir: directory });
  const controller = new AbortController();
  const records = [], reads = [];
  let active = 0, maxActive = 0;
  const proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: controller.signal, onListen() {} }, async request => {
    const url = new URL(request.url);
    const mutation = ["POST", "PATCH", "DELETE"].includes(request.method) && /^\/_\/api\/notes(?:\/|$)/.test(url.pathname);
    if (request.method === "GET" && /^\/_\/api\/notes\//.test(url.pathname)) reads.push(url.pathname);
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    let record;
    if (mutation) {
      active++; maxActive = Math.max(active, maxActive);
      let release;
      const released = new Promise(resolve => { release = resolve; });
      record = { method: request.method, path: url.pathname, body: body?.byteLength ? JSON.parse(new TextDecoder().decode(body)) : null, release, released, fault: false };
      records.push(record);
    }
    try {
      const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
      const response = await fetch(`${server.baseUrl}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (!record) return new Response(response.body, { status: response.status, headers: response.headers });
      const bytes = new Uint8Array(await response.arrayBuffer());
      record.backendStatus = response.status;
      record.backendResult = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null;
      let timer;
      try { await Promise.race([released(record), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned response deadline")), 30000); })]); }
      finally { clearTimeout(timer); }
      return record.fault ? Response.json({ detail: "Controlled lost acknowledgement" }, { status: 502 }) : new Response(bytes.length ? bytes : null, { status: response.status, headers: response.headers });
    } catch (error) {
      if (record) record.error = error.message;
      return Response.json({ detail: "Owned proxy transport failure" }, { status: 502 });
    } finally { if (record) active--; }
  });
  function released(record) { return record.released; }
  const session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9333) });
  current = { name, directory, vault, state, server, proxy, controller, records, reads, session, maxActive: () => maxActive };
  await session.goto(`http://127.0.0.1:${proxy.addr.port}/${create ? "_/new?path=First" : "NoteA"}`);
  await session.poll(create ? "!!document.querySelector('.cm-content')" : "!!document.querySelector('.toast-viewer')");
  if (!view && !create) { await session.button("Edit", ".content-column"); await session.button("Source", ".content-column"); }
  return current;
}
async function text(value) {
  const { session } = current;
  await session.click(".cm-content[contenteditable=true]");
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await session.type(value);
  await session.poll(`document.querySelector('.cm-content')?.textContent === ${JSON.stringify(value)}`);
}
const save = () => current.session.button("Save", ".content-column");
async function request(index) { await wait(() => current.records[index]?.backendStatus !== undefined); return current.records[index]; }
async function release(index, fault = false) { const record = await request(index); record.fault = fault; record.release(); }
async function observe() {
  return current.session.evaluate("({url:location.pathname+location.search+location.hash,buffer:document.querySelector('.cm-content,.ProseMirror')?.textContent,unload:typeof window.onbeforeunload,dirty:[...document.querySelectorAll('.content-column button')].find(el=>el.textContent.trim()==='Save')?.querySelector('svg')?.classList.contains('text-theme-brand'),status:document.querySelector('[data-note-save-status]')?.textContent})");
}
async function readBack(path = "NoteA") {
  const response = await fetch(`${current.server.baseUrl}/_/api/notes/${path}`, { signal: AbortSignal.timeout(5000) });
  const api = await response.json();
  const disk = await Deno.readTextFile(`${current.vault}/${path}.md`);
  assert(api.content === disk, "API and disk content differ");
  return { api, disk };
}
// A fixture-only link drives the public Vue Router instance with native input.
// It is needed because Source has no same-note query control. No app code changes.
async function routeLink(destination) {
  await current.session.evaluate(`(() => { const root=document.querySelector('#app'); const router=root.__vue_app__.config.globalProperties.$router; let link=document.querySelector('#owner-route-link'); if(!link){link=document.createElement('a'); link.id='owner-route-link'; link.style.cssText='position:fixed;bottom:0;right:0;z-index:99999;padding:8px;background:white;color:black'; document.body.append(link);} link.textContent='Owned query transition'; link.href=${JSON.stringify(destination)}; link.onclick=event=>{event.preventDefault();router.push(${JSON.stringify(destination)});}; return true; })()`);
  await current.session.click("#owner-route-link");
}
async function markEditor() {
  await current.session.evaluate("window.__ownerEditor=document.querySelector('.cm-content'); true");
}
async function assertOwner(buffer, reads) {
  assert(await current.session.evaluate(`document.querySelector('.cm-content') === window.__ownerEditor && document.querySelector('.cm-content').textContent === ${JSON.stringify(buffer)} && typeof window.onbeforeunload === 'function'`), "Query transition replaced the editor/buffer/unload protection");
  assert(current.reads.length === reads, "Query transition performed another note GET");
}
async function finish(evidence = {}) {
  const resource = current;
  assert(!resource.session.errors.length, "Unexpected browser exception");
  await resource.session.evaluate("document.querySelector('#owner-route-link')?.remove(); true");
  const page = await observe();
  const { data } = await resource.session.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${resource.directory}/outcome.png`, Uint8Array.from(atob(data), char => char.charCodeAt(0)));
  await Deno.writeTextFile(`${resource.directory}/consumer.json`, JSON.stringify({ page, evidence, reads: resource.reads, maxActive: resource.maxActive(), records: resource.records.map(({ release, released, ...record }) => record), errors: resource.session.errors, events: resource.session.events, targetId: resource.session.targetId, browserContextId: resource.session.browserContextId }, null, 2));
  outcomes.push({ name: resource.name, passed: true }); console.log(`ok: ${resource.name}`);
  await resource.session.close(); resource.controller.abort(); await resource.proxy.finished; await resource.server.close(); resource.closed = true;
}

try {
  await setup("query-abc-history");
  for (const marker of ["OWNER-A", "OWNER-B", "OWNER-C"]) { await text(marker); await save(); }
  await request(0); await text("OWNER-D"); await markEditor(); const reads = current.reads.length;
  await routeLink("/NoteA?folder=x&path=ignored#source"); await current.session.poll("location.search.includes('folder=x')"); await assertOwner("OWNER-D", reads);
  const history = await current.session.send("Page.getNavigationHistory");
  await current.session.send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id }); await current.session.poll("!location.search"); await assertOwner("OWNER-D", reads);
  await current.session.send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex].id }); await current.session.poll("location.search.includes('folder=x')"); await assertOwner("OWNER-D", reads);
  assert(current.records.length === 1, "Query admitted a concurrent foreground request");
  for (let index = 0; index < 3; index++) { await request(index); await release(index); }
  await current.session.poll("!document.querySelector('.content-column .animate-spin')");
  assert(current.maxActive() === 1 && current.records.map(record => record.body.newContent).join("|") === "OWNER-A|OWNER-B|OWNER-C", "Literal FIFO order/overlap changed");
  const saved = await readBack(); assert(saved.disk === "OWNER-C", "Disk does not contain C"); await assertOwner("OWNER-D", reads); await finish(saved);

  for (const status of ["idle", "known", "unknown"]) {
    await setup(`query-${status}`); await text(status === "known" ? "OWNER-GUARD" : "OWNER-D");
    if (status !== "idle") { await save(); await request(0); await release(0, status === "unknown"); await current.session.poll("document.querySelector('[data-note-save-status]')?.textContent.includes('paused')"); }
    await markEditor(); const reads = current.reads.length;
    await routeLink("/NoteA?folder=query#source"); await current.session.poll("location.search.includes('query')"); await assertOwner(status === "known" ? "OWNER-GUARD" : "OWNER-D", reads);
    if (status !== "idle") { await current.session.button("Delete", ".content-column"); assert(await current.session.evaluate("!document.body.innerText.includes('Confirm Deletion')"), "Delete ignored retained queue work"); }
    if (status === "known") await current.session.button("Cancel", '[data-modal-top="true"]');
    await finish(await readBack());
  }

  await setup("fresh-view-delete", { view: true }); await current.session.button("Delete", ".content-column");
  await current.session.poll("document.body.innerText.includes('Confirm Deletion')"); assert(await current.session.evaluate("!document.body.innerText.includes('Save Changes')"), "Fresh view Delete created a save decision");
  await current.session.button("Cancel", '[data-modal-top="true"]'); assert(current.records.length === 0, "Cancel mutated the note"); await readBack();
  await current.session.button("Delete", ".content-column"); await current.session.button("Delete", '[data-modal-top="true"]'); await request(0); await release(0);
  await current.session.poll("location.pathname === '/'");
  const deleted = await fetch(`${current.server.baseUrl}/_/api/notes/NoteA`, { signal: AbortSignal.timeout(5000) }); assert(deleted.status === 404, "Deleted note remains in API"); await deleted.body?.cancel();
  let exists = true; try { await Deno.stat(`${current.vault}/NoteA.md`); } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; exists = false; }
  const index = await (await fetch(`${current.server.baseUrl}/_/api/note-index`, { signal: AbortSignal.timeout(5000) })).json();
  assert(!exists && !index.some(entry => entry.path === "NoteA"), "Delete did not remove disk/index note"); await finish({ deletedStatus: 404, diskExists: exists, index });

  await setup("queued-delete-barrier"); await text("OWNER-delete-A"); await save(); await request(0); await text("OWNER-delete-B"); await save(); await text("OWNER-delete-D");
  await current.session.button("Delete", ".content-column");
  assert(await current.session.evaluate("!document.body.innerText.includes('Confirm Deletion') && !document.body.innerText.includes('Save Changes') && document.querySelector('.cm-content').textContent === 'OWNER-delete-D'"), "Pending Delete bypassed the queue barrier");
  await release(0); await request(1); await release(1); await current.session.poll("document.body.innerText.includes('Save Changes')");
  assert(current.records.length === 2 && await current.session.evaluate("!document.body.innerText.includes('Confirm Deletion')"), "Delete skipped the newer-work decision");
  await current.session.button("Cancel", '[data-modal-top="true"]'); const deleteSaved = await readBack();
  assert(deleteSaved.disk === "OWNER-delete-B" && await current.session.evaluate("document.querySelector('.cm-content').textContent === 'OWNER-delete-D' && typeof window.onbeforeunload === 'function'"), "Cancelled Delete lost C/D work"); await finish(deleteSaved);

  await setup("read-only-delete", { view: true, readonly: true }); assert(await current.session.evaluate("![...document.querySelectorAll('.content-column button')].some(el=>el.textContent.trim()==='Delete' && el.getBoundingClientRect().width)"), "Read-only Delete became visible"); await finish(await readBack());

  await setup("resource-decisions"); await text("OWNER-D"); await markEditor();
  await routeLink("/Other"); await current.session.poll("document.body.innerText.includes('Save Changes')"); assert(await current.session.evaluate("location.pathname === '/NoteA'"), "Resource URL committed before permission");
  await current.session.button("Cancel", '[data-modal-top="true"]'); await assertOwner("OWNER-D", current.reads.length);
  await routeLink("/Other"); await current.session.button("Discard", '[data-modal-top="true"]'); await current.session.poll("location.pathname === '/Other' && !!document.querySelector('.toast-viewer')"); await finish(await readBack("Other"));

  await setup("new-prefill-create-token", { create: true }); await text("OWNER-new-D");
  await routeLink("/_/new?path=Second&folder=target"); await current.session.poll("document.body.innerText.includes('Save Changes')");
  await current.session.button("Cancel", '[data-modal-top="true"]'); assert(await current.session.evaluate("location.search.includes('First') && document.querySelector('.cm-content').textContent === 'OWNER-new-D'"), "Cancelled prefill lost state/URL");
  await routeLink("/_/new?path=Second&folder=target"); await current.session.button("Discard", '[data-modal-top="true"]'); await current.session.poll("location.search.includes('Second') && !!document.querySelector('.cm-content')");
  await text("OWNER-create-A"); await save(); await request(0); await text("OWNER-create-B"); await save(); await text("OWNER-create-D"); await markEditor();
  await release(0); await request(1); assert(current.records[0].method === "POST" && current.records[1].method === "PATCH", "Canonical create reset the queue");
  await release(1); await current.session.poll("location.pathname === '/Second' && !document.querySelector('.content-column .animate-spin')");
  assert(await current.session.evaluate("document.querySelector('.cm-content') === window.__ownerEditor && document.querySelector('.cm-content').textContent === 'OWNER-create-D'"), "Canonical token replaced current editor"); await finish(await readBack("Second"));

  for (const kind of ["edit", "paste"]) {
    await setup(`wysiwyg-immediate-${kind}`); await current.session.button("WYSIWYG", ".content-column"); await current.session.poll("!!document.querySelector('.ProseMirror[contenteditable=true] > p')");
    await save(); const baseline = await request(0); await release(0); await current.session.poll("!document.querySelector('.content-column .animate-spin') && window.onbeforeunload === null");
    // OWNER_OBSERVE: passive native-property observation in this fresh page.
    // Delegate every assignment; record committed DOM inside the actual setter,
    // before a debounce or CDP poll can turn a delayed assignment into a pass.
    await current.session.evaluate("(() => {const descriptor=Object.getOwnPropertyDescriptor(window,'onbeforeunload'); window.__ownerChanges=[]; Object.defineProperty(window,'onbeforeunload',{configurable:descriptor.configurable,enumerable:descriptor.enumerable,get:()=>descriptor.get.call(window),set:value=>{descriptor.set.call(window,value); if(value) window.__ownerChanges.push({committedText:document.querySelector('.ProseMirror').textContent,unload:typeof descriptor.get.call(window),time:performance.now()});}}); return true;})()");
    await current.session.click(".ProseMirror > p"); await current.session.key("ArrowRight", { code: "ArrowRight", windowsVirtualKeyCode: 39 });
    assert(await current.session.evaluate("window.__ownerChanges.length === 0 && window.onbeforeunload === null"), "Selection dirtied a clean ACK");
    await current.session.evaluate("window.__ownerInputTime=performance.now(); true");
    const marker = kind === "edit" ? "Z" : "OWNER-paste";
    if (kind === "edit") {
      for (const type of ["keyDown", "keyUp"]) await current.session.send("Input.dispatchKeyEvent", { type, key: "Z", code: "KeyZ", windowsVirtualKeyCode: 90, ...(type === "keyDown" ? { text: "Z", unmodifiedText: "Z" } : {}) });
    } else await current.session.type(marker);
    await current.session.poll("window.__ownerChanges.length > 0");
    const immediate = await current.session.evaluate("window.__ownerChanges");
    const timing = await current.session.evaluate("({elapsed:window.__ownerChanges[0].time-window.__ownerInputTime,draft:sessionStorage.getItem('NoteA')})");
    assert(immediate.length === 1 && immediate[0].committedText.includes(marker) && immediate[0].unload === "function" && timing.elapsed < 250 && timing.draft === null, "First committed edit did not protect the consumer before debounce");
    await save(); await request(1); assert(current.records[1].body.newContent.includes(marker), "Save did not capture immediate committed bytes"); await release(1); await current.session.poll("!document.querySelector('.content-column .animate-spin') && window.onbeforeunload === null");
    const saved = await readBack(); assert(saved.disk === current.records[1].body.newContent, "Immediate buffer differs from saved API/disk bytes");
    await finish({ baseline: baseline.body.newContent, immediate, timing, saved, input: kind === "edit" ? "One native key character transaction" : "Native CDP Input.insertText browser insertion/paste path", observation: "Native unload setter delegates and records committed text synchronously; snapshot-inside-change is separately proved in real Milkdown component tests" });
  }
  console.log("NOTE SAVE OWNER GUARDS OK");
} catch (error) { failure = error; console.error(`FAIL: ${error.message}`); }
finally {
  await Deno.writeTextFile(`${artifacts}/summary.json`, JSON.stringify({ outcomes, failure: failure?.message, current: current && { name: current.name, targetId: current.session.targetId, browserContextId: current.session.browserContextId, serverPid: current.server.pid, vault: current.vault, state: current.state } }, null, 2));
  if (failure) {
    console.error(`Retained owner-guards failure: ${artifacts}/summary.json; release file ${artifacts}/release-failure`);
    for (;;) { try { await Deno.stat(`${artifacts}/release-failure`); break; } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; } await new Promise(resolve => setTimeout(resolve, 250)); }
  }
}
if (failure) throw failure;
