// VM-only native input + a guest-owned response gate around the real server.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { hashPassword } from "../../../server/helpers.ts";
import { SignJWT } from "jose";

let options;
try { options = parseArguments(Deno.args); } catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: note-save-fifo.mjs --artifacts <directory>"); Deno.exit(0); }
if (!options.artifacts) { console.error("--artifacts is required"); Deno.exit(2); }
const artifacts = options.artifacts;
try { await Deno.mkdir(artifacts, { mode: 0o700 }); }
catch (error) {
  if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  for await (const _ of Deno.readDir(artifacts)) throw new Error("Artifact destination is not empty");
}
const owned = [];
const outcomes = [];
let current, failure;
const assert = (condition, detail) => { if (!condition) throw new Error(detail); };
const wait = async predicate => {
  const end = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Proxy consumer deadline");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};

async function setup(label, { password = false, create = false } = {}) {
  const directory = `${artifacts}/${label}`;
  await Deno.mkdir(directory);
  const vault = await Deno.makeTempDir({ prefix: `fifo-${label}-vault-` });
  const state = await Deno.makeTempDir({ prefix: `fifo-${label}-state-` });
  await Deno.writeTextFile(`${vault}/NoteA.md`, "Seed content.\n");
  const secret = crypto.randomUUID();
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify(password
    ? { auth_type: "password", username: "fifo-user", password_hash: await hashPassword("fifo-secret"), secret_key: secret }
    : { auth_type: "none" }));
  await Deno.mkdir(`${state}/plugins/fifo-guard`, { recursive: true });
  await Deno.writeTextFile(`${state}/plugins/fifo-guard/manifest.json`, JSON.stringify({ id: "fifo-guard", runtime: { server: "service.js" }, hooks: ["pre-save"] }));
  await Deno.writeTextFile(`${state}/plugins/fifo-guard/service.js`, "export function activate(ctx) { ctx.hooks.on('pre-save', fact => (fact.proposed?.content ?? '').includes('FIFO-GUARD') ? {cancel:true,reason:'FIFO guard protection'} : {cancel:false}); }");
  const token = password ? await new SignJWT({ sub: "fifo-user" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(secret)) : null;
  const server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "" }, logsDir: directory, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const controller = new AbortController();
  const records = [];
  let active = 0, maxActive = 0;
  const proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: controller.signal, onListen() {} }, async request => {
    const url = new URL(request.url);
    const mutation = ["POST", "PATCH"].includes(request.method) && /^\/_\/api\/notes(?:\/|$)/.test(url.pathname);
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    let record;
    if (mutation) {
      active++; maxActive = Math.max(active, maxActive);
      let release;
      const released = new Promise(resolve => { release = resolve; });
      record = { id: records.length + 1, method: request.method, path: url.pathname, body: JSON.parse(new TextDecoder().decode(body)), release, released, fault: false };
      records.push(record);
    }
    try {
      const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
      const response = await fetch(`${server.baseUrl}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (!record) return new Response(response.body, { status: response.status, headers: response.headers });
      const bytes = new Uint8Array(await response.arrayBuffer());
      record.backendStatus = response.status;
      record.backendResult = JSON.parse(new TextDecoder().decode(bytes));
      let timer;
      try { await Promise.race([record.released, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned response gate deadline")), 30000); })]); }
      finally { clearTimeout(timer); }
      if (record.fault) return Response.json({ detail: "Controlled lost acknowledgement after the real server result" }, { status: 502 });
      return new Response(bytes, { status: response.status, headers: response.headers });
    } catch (error) {
      if (record) record.error = error.message;
      return Response.json({ detail: "Owned test proxy transport failure" }, { status: 502 });
    } finally { if (record) active--; }
  });
  const baseUrl = `http://127.0.0.1:${proxy.addr.port}`;
  const session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9333) });
  current = { label, directory, vault, state, server, proxy, controller, records, session, baseUrl, maxActive: () => maxActive };
  owned.push(current);
  await session.goto(`${baseUrl}/${create ? "_/new" : "NoteA"}`);
  if (password) {
    await session.poll("!!document.querySelector('#username')");
    await session.click("#username"); await session.type("fifo-user"); await session.click("#password"); await session.type("fifo-secret"); await session.button("Log In");
  }
  await session.poll(create ? "!!document.querySelector('.cm-content')" : "!!document.querySelector('.toast-viewer')");
  if (!create) { await session.button("Edit", ".content-column"); await session.button("Source", ".content-column"); }
  if (create) {
    await session.click('input[placeholder="Title"]'); await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await session.type("FifoCreated");
  }
  await session.poll("!!document.querySelector('.cm-content')");
  // FIFO_FONT_READY_PRECONDITION_START
  // Measure native Save only after its actual local label face has settled.
  await session.poll("[...document.querySelectorAll('.content-column button')].some(el=>el.textContent.trim()==='Save' && el.getBoundingClientRect().width)");
  const fontReadiness = await session.evaluate(`(async () => {
    const button=[...document.querySelectorAll('.content-column button')].find(el=>el.textContent.trim()==='Save');
    const label=button?.querySelector('span');
    if(!label)throw Error('Actual Save label missing for font readiness');
    const css=getComputedStyle(label),family=css.fontFamily.split(',')[0].trim().replace(/['"]/g,'');
    const font=css.fontStyle+' '+css.fontWeight+' '+css.fontSize+' '+css.fontFamily;
    const faces=await document.fonts.load(font,'Save');
    await document.fonts.ready;
    if(!faces.length || faces.some(face=>face.status!=='loaded' || face.family.replace(/['"]/g,'')!==family))
      throw Error('Matching local Save label faces did not load');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {font,faces:faces.map(face=>({family:face.family,weight:face.weight,style:face.style,status:face.status}))};
  })()`);
  await Deno.writeTextFile(`${directory}/font-ready.json`, JSON.stringify(fontReadiness, null, 2));
  // FIFO_FONT_READY_PRECONDITION_END
  return current;
}

async function text(value, mode = "Source") {
  const { session } = current;
  if (mode === "Preview") await session.button("Source", ".content-column");
  else await session.button(mode, ".content-column");
  const selector = mode === "WYSIWYG" ? ".ProseMirror[contenteditable=true] > p" : ".cm-content[contenteditable=true]";
  await session.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
  await session.click(selector);
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 });
  await session.type(value);
  await session.poll(`document.querySelector(${JSON.stringify(mode === "WYSIWYG" ? ".ProseMirror" : ".cm-content")})?.textContent.includes(${JSON.stringify(value)})`);
  if (mode === "Preview") { await session.button("Preview", ".content-column"); await session.poll(`document.querySelector('.preview-buffer')?.textContent.includes(${JSON.stringify(value)})`); }
}
async function save() { await current.session.button("Save", ".content-column"); }
async function request(index) { await wait(() => current.records[index]?.backendStatus !== undefined); return current.records[index]; }
async function release(index, fault = false) { const item = await request(index); item.fault = fault; item.release(); }
const editableText = () => current.session.evaluate("document.querySelector('.cm-content,.ProseMirror,.preview-buffer')?.textContent");
const paused = () => current.session.poll("document.querySelector('[data-note-save-status]')?.textContent.toLowerCase().includes('paused')");
async function snapshot(name) {
  const { session, directory } = current;
  const page = await session.evaluate("({url:location.href,body:document.body.innerText,active:document.activeElement?.tagName,buttons:[...document.querySelectorAll('.content-column button')].map(el=>({text:el.textContent.trim(),disabled:el.disabled,busy:el.getAttribute('aria-busy'),rect:el.getBoundingClientRect().toJSON()}))})");
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${directory}/${name}.png`, Uint8Array.from(atob(data), char => char.charCodeAt(0)));
  await Deno.writeTextFile(`${directory}/${name}.json`, JSON.stringify(page, null, 2));
}
async function finishCase() {
  const resource = current;
  assert(resource.session.errors.length === 0, "Unexpected browser exception");
  await snapshot("outcome");
  await Deno.writeTextFile(`${resource.directory}/requests.json`, JSON.stringify({ maxActive: resource.maxActive(), records: resource.records.map(({ release, released, ...record }) => record), errors: resource.session.errors, events: resource.session.events, targetId: resource.session.targetId, browserContextId: resource.session.browserContextId }, null, 2));
  outcomes.push({ name: resource.label, passed: true }); console.log(`ok: ${resource.label}`);
  await resource.session.close(); resource.controller.abort(); await resource.proxy.finished; await resource.server.close();
  resource.closed = true;
}

try {
  for (const mode of ["Source", "WYSIWYG", "Preview"]) {
    await setup(`abc-${mode.toLowerCase()}`);
    await text("FIFO-A", mode);
    const geometry = await current.session.evaluate("(() => {const button=[...document.querySelectorAll('.content-column button')].find(el=>el.textContent.trim()==='Save'); const svg=button.querySelector('svg'); return {button:button.getBoundingClientRect().toJSON(),svg:svg.getBoundingClientRect().toJSON(),cssWidth:getComputedStyle(svg).width,cssHeight:getComputedStyle(svg).height,viewBox:svg.getAttribute('viewBox')};})()");
    await save(); await request(0);
    const activity = await current.session.evaluate("(() => {const button=[...document.querySelectorAll('.content-column button')].find(el=>el.textContent.trim()==='Save'); const svg=button.querySelector('svg'); return {disabled:button.disabled,busy:button.getAttribute('aria-busy'),animation:getComputedStyle(svg).animationName,button:button.getBoundingClientRect().toJSON(),svg:svg.getBoundingClientRect().toJSON(),cssWidth:getComputedStyle(svg).width,cssHeight:getComputedStyle(svg).height,viewBox:svg.getAttribute('viewBox')};})()");
    assert(!activity.disabled && activity.busy === "true" && activity.animation.includes("spin"), "Save activity is missing or Save disabled");
    await Deno.writeTextFile(`${current.directory}/geometry.json`, JSON.stringify({ geometry, activity }, null, 2)); await snapshot("saving");
    // Rotation changes the axis-aligned visual bounding box, not its layout
    // slot. Check fixed CSS/viewBox and button dimensions; retain both rects.
    assert(activity.cssWidth === geometry.cssWidth && activity.cssHeight === geometry.cssHeight && activity.viewBox === geometry.viewBox && Math.abs(activity.button.width - geometry.button.width) < 0.5 && Math.abs(activity.button.height - geometry.button.height) < 0.5, "Spinner changed its icon-slot geometry");
    await text("FIFO-B", mode); await save(); await text("FIFO-C", mode); await save(); await text("FIFO-D", mode);
    await current.session.poll("document.querySelector('[data-note-save-status]')?.textContent.includes('2 queued')");
    assert(current.records.length === 1, "B/C reached the server before A acknowledgement");
    await release(0); await request(1); assert((await editableText()).includes("FIFO-D"), "A replaced newer D");
    await release(1); await request(2); await release(2);
    await current.session.poll("!document.querySelector('.content-column .animate-spin')");
    assert(current.maxActive() === 1, "Foreground requests overlapped");
    const bodies = current.records.map(item => item.body.newContent);
    assert(bodies.length === 3 && bodies[0].includes("FIFO-A") && bodies[1].includes("FIFO-B") && bodies[2].includes("FIFO-C"), "FIFO request snapshots changed or were skipped");
    assert((await editableText()).includes("FIFO-D"), "Final acknowledgement replaced unsent D");
    const api = await (await fetch(`${current.server.baseUrl}/_/api/notes/NoteA`, { signal: AbortSignal.timeout(5000) })).json();
    const disk = await Deno.readTextFile(`${current.vault}/NoteA.md`);
    assert(disk === api.content && disk.includes("FIFO-C") && !disk.includes("FIFO-D"), "API/disk consumer does not contain exactly acknowledged C");
    await finishCase();
  }
  await setup("duplicate-keyboard"); await text("FIFO-equal"); await save(); await request(0);
  // Enter activates a focused native button via its character event. The
  // keyDown-only helper is sufficient for shortcuts but does not emit that.
  for (const type of ["keyDown", "keyUp"]) await current.session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  await current.session.poll("document.querySelector('[data-note-save-status]')?.textContent.includes('1 queued')");
  await release(0); await request(1); await release(1); await current.session.poll("!document.querySelector('.content-column .animate-spin')");
  assert(current.records.length === 2 && current.records[0].body.newContent === current.records[1].body.newContent, "Equal keyboard Save was coalesced"); await finishCase();

  await setup("creation-lineage", { create: true });
  await text("FIFO-create-A"); await save(); await request(0); await text("FIFO-create-B"); await save(); await text("FIFO-create-D");
  await release(0); await request(1);
  assert(current.records[0].method === "POST" && current.records[1].method === "PATCH" && current.records[1].path.endsWith("/FifoCreated"), "Creation lineage performed a second POST or stale PATCH");
  await release(1); await current.session.poll("location.pathname === '/FifoCreated' && !document.querySelector('.content-column .animate-spin')");
  assert((await editableText()).includes("FIFO-create-D"), "Canonical creation route reset the editor"); await finishCase();

  await setup("rename-lineage"); await text("FIFO-rename-A");
  await current.session.click('input[placeholder="Title"]'); await current.session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await current.session.type("Q");
  await save(); await request(0); await text("FIFO-rename-B"); await save();
  await release(0); await request(1);
  assert(current.records[1].path.endsWith("/Q") && current.records[1].body.newPath === "Q", "Queued rename used stale identity");
  await release(1); await current.session.poll("location.pathname === '/Q' && !document.querySelector('.content-column .animate-spin')"); await finishCase();

  for (const fault of [false, true]) {
    await setup(fault ? "unknown-after-commit" : "known-guard-rejection");
    await text(fault ? "FIFO-A" : "FIFO-GUARD"); await save(); const a = await request(0);
    await text("FIFO-held-B"); await save(); await text("FIFO-new-D");
    await release(0, fault); await paused(); await save();
    await current.session.poll("document.querySelector('[data-note-save-status]')?.textContent.includes('2 held saves')");
    assert(current.records.length === 1 && (await editableText()).includes("FIFO-new-D"), "Paused work was retried, dispatched or lost");
    assert(a.backendStatus === (fault ? 200 : 409), "Controlled failure lacks its real producer result"); await finishCase();
  }
  for (const action of ["logout", "finish"]) {
    await setup(`pending-${action}`, { password: true }); await text("FIFO-pending-A"); await save(); await request(0);
    await current.session.evaluate("window.__fifoToken = sessionStorage.getItem('token'); true");
    await current.session.click('[title="Open sidebar"]'); await current.session.poll("!!document.querySelector('[aria-label=Settings]')"); await current.session.click('[aria-label="Settings"]'); await current.session.button(action === "logout" ? "Account" : "Access");
    if (action === "logout") await current.session.button("Log out");
    else {
      await current.session.button("Change access mode"); await current.session.poll("!!document.querySelector('#access-current-password') && !document.querySelector('#setup-mode-read_only').disabled");
      await current.session.click("#access-current-password"); await current.session.type("fifo-secret");
      await current.session.click("#setup-mode-read_only"); await current.session.button("Save access settings");
    }
    assert(await current.session.evaluate("sessionStorage.getItem('token') === window.__fifoToken && !!document.querySelector('.cm-content')"), "Pending handoff revoked credentials/editor");
    await release(0);
    await current.session.poll(action === "logout" ? "!!document.querySelector('#username') && sessionStorage.getItem('token') === null" : "!document.querySelector('#setup-title') && location.pathname === '/'");
    const disk = await Deno.readTextFile(`${current.vault}/NoteA.md`); assert(disk.includes("FIFO-pending-A"), "Handoff did not wait for acknowledged disk content");
    if (action === "finish") assert(JSON.parse(await Deno.readTextFile(`${current.state}/config.json`)).auth_type === "read_only", "Finish did not persist its approved auth transition");
    await finishCase();
  }
  console.log("NOTE SAVE FIFO OK");
} catch (error) { failure = error; console.error(`FAIL: ${error.message}`); }
finally {
  await Deno.writeTextFile(`${artifacts}/summary.json`, JSON.stringify({ outcomes, failure: failure?.message, current: current && { name: current.label, targetId: current.session.targetId, browserContextId: current.session.browserContextId, baseUrl: current.baseUrl, serverPid: current.server.pid, vault: current.vault, state: current.state } }, null, 2));
  if (failure) {
    if (current && !current.closed) await snapshot("failure").catch(error => console.error(error.message));
    console.error(`Retained FIFO failure: ${artifacts}/summary.json; release file ${artifacts}/release-failure`);
    for (;;) {
      try { await Deno.stat(`${artifacts}/release-failure`); break; }
      catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
if (failure) throw failure;
