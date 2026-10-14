// GPS08: native production consumers and actual HTTP auth/stream boundaries.
import { nativeSession } from "./native-cdp-session.mjs";
import { parseArguments } from "./harness-helpers.mjs";
import { bootPrefixAuthFixture } from "./prefix-auth-fixture.mjs";
import { hashPassword } from "../../../server/helpers.ts";
import { SignJWT } from "jose";

let options;
try { options = parseArguments(Deno.args); } catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: plugin-prefix-auth.mjs --artifacts <directory>"); Deno.exit(0); }
if (!options.artifacts) { console.error("--artifacts is required"); Deno.exit(2); }
const artifacts = options.artifacts;
await Deno.mkdir(artifacts, { mode: 0o700 });
const assert = (value, message) => { if (!value) throw Error(message); };
const username = "gps08-fixture", password = "gps08-original-password", nextPassword = "gps08-replacement-password";
const seed = "GPS08 seed.\n", outcomes = [];
let current, failure;

async function wait(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < end, "Prefix/auth consumer observation deadline");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function privateBytes() {
  try { return await Deno.readTextFile(`${current.state}/plugin-data/gps08/data.json`); }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; return null; }
}
async function api(route, method = "GET", body, token = current.token) {
  const response = await fetch(`${current.server.baseUrl}${current.prefix}${route}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  const text = await response.text(), value = response.headers.get("content-type")?.includes("application/json") && text ? JSON.parse(text) : text;
  const result = { route, method, status: response.status, body: value };
  current.responses.push(result); return result;
}
const signed = (secret, expiresAt) => new SignJWT({ sub: username }).setProtectedHeader({ alg: "HS256" }).setExpirationTime(expiresAt).sign(new TextEncoder().encode(secret));
async function fill(session, selector, value) {
  // GPS08_NATIVE_FIELD_READINESS: passive snapshots of the real control.
  const inspect = () => session.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});return input&&{value:input.value,readOnly:input.readOnly,disabled:input.disabled,focused:document.activeElement===input,documentFocused:document.hasFocus(),inert:!!input.closest('[inert]'),rect:input.getBoundingClientRect().toJSON()};})()`);
  const fieldDiagnostic = selector === "#settings-field-message";
  const before = fieldDiagnostic ? await inspect() : null;
  await session.poll(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});return input&&!input.readOnly&&!input.disabled&&!input.closest('[inert]')&&input.getBoundingClientRect().width>0;})()`);
  const ready = fieldDiagnostic ? await inspect() : null;
  await session.click(selector);
  await session.poll(`document.activeElement===document.querySelector(${JSON.stringify(selector)}) && !document.activeElement.disabled && !document.activeElement.readOnly`);
  await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type(value);
  // GPS08_NATIVE_FIELD_READINESS: record before checking the final value.
  if (fieldDiagnostic) await Deno.writeTextFile(`${current.directory}/native-field-readiness.json`, JSON.stringify({ selector, before, ready, after: await inspect() }, null, 2), { createNew: true });
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`);
}
async function login(session, value = password) {
  await session.poll("!!document.querySelector('#username')");
  await fill(session, "#username", username); await fill(session, "#password", value);
  await session.button("Log In");
  // GPS08_LOGIN_BOUNDARY_DIAGNOSTIC: observe actual receipt; never inject a token.
  await session.poll("!!sessionStorage.getItem('token')");
  const received = await session.evaluate("sessionStorage.getItem('token')");
  const proof = await api("/_/api/auth-check", "GET", undefined, received);
  const cookies = (await session.send("Network.getCookies", { urls: [`${current.server.baseUrl}${current.prefix}/_/plugins/gps08/app.js`] })).cookies.map(cookie => ({ name: cookie.name, path: cookie.path, domain: cookie.domain, sameSite: cookie.sameSite }));
  const observations = current.loginObservations ??= [];
  observations.push({ targetId: session.targetId, receivedTokenPresent: !!received, actualAuthCheck: proof, cookieScopes: cookies, page: await session.evaluate("({url:location.href,prefix:document.querySelector('meta[name=globnotes-prefix]')?.content,runtime:!!window.__gps08Runtime,disposed:window.__gps08Disposed??0})") });
  await Deno.writeTextFile(`${current.directory}/login-boundary-${observations.length}.json`, JSON.stringify(observations.at(-1), null, 2), { createNew: true });
  await session.poll("!!window.__gps08Runtime && !!document.querySelector('.toast-viewer')");
  return session.evaluate("sessionStorage.getItem('token')");
}
async function palette(session) {
  if (!session.gps08PaletteLayerSelected) {
    await session.click('[title="Open sidebar"]'); await session.click('[aria-label="Settings"]');
    await session.button("Keybindings"); await session.button("Obsidian");
    await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')");
    await session.click('[title="Close sidebar"]');
    session.gps08PaletteLayerSelected = true;
  }
  await session.key("p", { code: "KeyP", modifiers: 2, windowsVirtualKeyCode: 80 });
  await session.poll("!!document.querySelector('input[placeholder=\"Type a command…\"]')");
  await session.click('input[placeholder="Type a command…"]'); await session.type("GPS08 browser settings consumer");
  await session.poll("document.querySelector('[data-modal-top=true] li')?.textContent.includes('GPS08 browser settings consumer')");
  await session.key("Enter", { windowsVirtualKeyCode: 13 });
  await session.poll("!document.querySelector('#command-palette-title') && !!document.querySelector('[data-gps08-consumer]')");
  assert(await session.evaluate("(()=>{const element=document.querySelector('[data-gps08-consumer]'),r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), "Actual SDK palette consumer is not rendered/hittable");
}
async function screenshot(session, label) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${current.directory}/${label}.png`, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { createNew: true });
}
async function stream(token) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  let response;
  try { response = await fetch(`${current.server.baseUrl}${current.prefix}/_/api/plugin-host/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal }); }
  finally { clearTimeout(timer); }
  assert(response.status === 200, `Actual stream rejected: ${response.status}`);
  const state = { text: "", closed: false }, reader = response.body.getReader(), decoder = new TextDecoder();
  const drained = (async () => {
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) { state.closed = true; break; } state.text += decoder.decode(value, { stream: true }); }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  const result = { state, drained, async close() { controller.abort(); await drained; } };
  current.streams.push(result); await wait(() => state.text.includes("event: hello")); return result;
}
async function fixture(prefix, mode) {
  const label = `${prefix ? "notes" : "empty"}-${mode}`, directory = `${artifacts}/${label}`;
  await Deno.mkdir(directory);
  const vault = await Deno.makeTempDir({ prefix: `gps08-${label}-vault-` }), state = await Deno.makeTempDir({ prefix: `gps08-${label}-state-` });
  const secret = crypto.randomUUID();
  await Deno.writeTextFile(`${vault}/Seed.md`, seed);
  if (mode !== "setup") await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: mode, ...(mode === "password" ? { username, password_hash: await hashPassword(password), secret_key: secret } : {}) }));
  await Deno.mkdir(`${state}/plugins/gps08/endpoints/query`, { recursive: true });
  await Deno.mkdir(`${state}/plugins/gps08/endpoints/counts`);
  await Deno.writeTextFile(`${state}/plugins.json`, JSON.stringify({ enabled: ["gps08"], autoEnable: false }));
  await Deno.writeTextFile(`${state}/plugins/gps08/manifest.json`, JSON.stringify({ id: "gps08", runtime: { server: "service.js", client: "custom-browser-entry.js" }, client: { entry: "custom-editor-entry.js" }, hooks: ["on-save"], settings: [{ id: "preferences", label: "GPS08 preferences", renderer: { kind: "declarative-v1", version: 1 }, fields: [{ key: "message", label: "Message", type: "text", default: "GPS08 default", maxLength: 100 }] }] }));
  await Deno.writeTextFile(`${state}/plugins/gps08/counts.js`, "let commands=0,queries=0;export const read=()=>({commands,queries});export const command=()=>{commands++;};export const query=()=>{queries++;};");
  await Deno.writeTextFile(`${state}/plugins/gps08/service.js`, "import {read,command} from './counts.js';export function activate(ctx){console.log('GPS08_WORKER_ACTIVATED');ctx.commands.register({id:'consume',label:'GPS08 server consumer',target:'server'},async()=>{command();const message=(await ctx.settings.read()).values.preferences.message;const data=await ctx.data.load();await ctx.data.save({...data.values,commands:(data.values.commands??0)+1,message,privateProof:'GPS08_PRIVATE_PROOF'},data.revision);return {message,...read()};});ctx.hooks.on('on-save',async fact=>{const data=await ctx.data.load();await ctx.data.save({...data.values,saves:(data.values.saves??0)+1,content:fact.after.content,message:(await ctx.settings.read()).values.preferences.message},data.revision);});}");
  await Deno.writeTextFile(`${state}/plugins/gps08/endpoints/query/get.js`, "import {query,read} from '../../counts.js';export default request=>{query();return {query:request.query,...read()};};");
  await Deno.writeTextFile(`${state}/plugins/gps08/endpoints/counts/get.js`, "import {read} from '../../counts.js';export default ()=>read();");
  await Deno.writeTextFile(`${state}/plugins/gps08/custom-browser-entry.js`, "import * as sdk from '@globnotes/plugin-sdk';import * as milk from '@milkdown/utils';export async function activate(ctx){window.__gps08Runtime={sdk,milk,version:sdk.PLUGIN_SDK_VERSION,message:(await ctx.settings.read('preferences')).values.message};let output;ctx.commands.register({id:'browser-consumer',label:'GPS08 browser settings consumer',target:'browser'},async()=>{const message=(await ctx.settings.read('preferences')).values.message;if(!output){output=document.createElement('div');output.setAttribute('data-gps08-consumer','');document.body.prepend(output);}output.textContent=message;return message;});ctx.register(()=>{output?.remove();delete window.__gps08Runtime;window.__gps08Disposed=(window.__gps08Disposed??0)+1;});}");
  await Deno.writeTextFile(`${state}/plugins/gps08/custom-editor-entry.js`, "import * as sdk from '@globnotes/plugin-sdk';import * as milk from '@milkdown/utils';window.__gps08Editor={sdk,milk,version:sdk.PLUGIN_SDK_VERSION};export default [];");
  const bootstrap = mode === "password" ? await signed(secret, "1h") : null;
  current = { label, directory, vault, state, secret, prefix, mode, responses: [], sessions: [], streams: [], token: bootstrap, closed: false };
  current.server = await bootPrefixAuthFixture({ directory, vault, state, prefix, setup: mode === "setup", headers: bootstrap ? { authorization: `Bearer ${bootstrap}` } : {} });
  const session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) }); current.session = session; current.sessions.push(session);
  // GPS08_LOGIN_BOUNDARY_DIAGNOSTIC: normalized wire/navigation, no credentials.
  current.wire = [];
  session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent") {
      const request = event.params.request, headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
      current.wire.push({ method: event.method, requestId: event.params.requestId, url: request.url, httpMethod: request.method, bearerPresent: !!headers.authorization, cookiePresent: !!headers.cookie, observedAt: Date.now() });
    } else if (event.method === "Network.requestWillBeSentExtraInfo") {
      const headers = Object.fromEntries(Object.entries(event.params.headers).map(([key, value]) => [key.toLowerCase(), value]));
      current.wire.push({ method: event.method, requestId: event.params.requestId, bearerPresent: !!headers.authorization, cookiePresent: !!headers.cookie, observedAt: Date.now() });
    } else if (event.method === "Network.responseReceived") current.wire.push({ method: event.method, requestId: event.params.requestId, url: event.params.response.url, status: event.params.response.status, observedAt: Date.now() });
    else if (event.method === "Page.navigatedWithinDocument") current.wire.push({ method: event.method, url: event.params.url, observedAt: Date.now() });
  });
  await Deno.writeTextFile(`${directory}/ownership.json`, JSON.stringify({ label, vault, state, prefix, mode, serverPid: current.server.pid, baseUrl: current.server.baseUrl, targetId: session.targetId, browserContextId: session.browserContextId }), { createNew: true });
  await session.goto(`${current.server.baseUrl}${prefix}/Seed`);
}
async function closeCurrent() {
  if (!current || current.closed) return;
  for (const stream of current.streams) await stream.close();
  for (const session of current.sessions) await session.close();
  await current.server?.close(); current.closed = true;
  await Deno.writeTextFile(`${current.directory}/closure.json`, JSON.stringify({ serversClosed: true, targetsAndContextsClosed: current.sessions.map(session => ({ targetId: session.targetId, browserContextId: session.browserContextId })), filesRetained: true }), { createNew: true });
}
async function configured() {
  const { mode, prefix, session, directory, server, state, vault } = current;
  if (mode === "password") {
    await session.poll("!!document.querySelector('#username')");
    assert(!await session.evaluate("!!window.__gps08Runtime || !!window.__gps08Editor"), "Unauthenticated document executed plugin consumers");
    const before = (await api("/_/api/plugins/gps08/counts")).body;
    for (const route of ["/_/plugins/gps08/app.js?v=gps08", "/_/plugins/gps08/client.js", "/_/api/plugin-host/gps08/settings/preferences", "/_/api/plugins/gps08/query?x=1&x=2"]) assert((await api(route, "GET", undefined, null)).status === 401, "Password rejection escaped a protected consumer");
    assert((await api("/_/api/plugin-host/gps08/commands/consume", "POST", {}, null)).status === 401, "Unauthorized command executed");
    assert(JSON.stringify((await api("/_/api/plugins/gps08/counts")).body) === JSON.stringify(before), "Rejected requests changed actual Worker counters");
    assert(await privateBytes() === null && await Deno.readTextFile(`${vault}/Seed.md`) === seed, "Unauthorized requests changed private data/note bytes");
    current.token = await login(session);
    for (const authenticated of [true, false]) {
      const peer = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) }); current.sessions.push(peer);
      await peer.goto(`${server.baseUrl}${prefix}/Seed`);
      if (authenticated) { await login(peer); current.peer = peer; }
      else { await peer.poll("!!document.querySelector('#username')"); assert(!await peer.evaluate("!!window.__gps08Runtime"), "Unauthenticated control borrowed a login"); }
    }
    await Deno.writeTextFile(`${directory}/peer-ownership.json`, JSON.stringify(current.sessions.slice(1).map(peer => ({ targetId: peer.targetId, browserContextId: peer.browserContextId }))), { createNew: true });
    assert(new Set(current.sessions.map(peer => peer.browserContextId)).size === 3, "Password peers do not have independent cookie contexts");
  } else await session.poll("!!window.__gps08Runtime && !!document.querySelector('.toast-viewer')");
  assert(await session.evaluate(`document.querySelector('meta[name="globnotes-prefix"]').content===${JSON.stringify(prefix)} && window.__gps08Runtime.version===1`), "Actual runtime/HTML prefix/SDK consumer mismatch");
  const sdk = await session.evaluate("JSON.parse(document.querySelector('script[type=importmap]').textContent).imports['@globnotes/plugin-sdk']");
  assert(sdk.startsWith(`${prefix}/_/assets/`) && (await api(sdk.slice(prefix.length), "GET", undefined, null)).status === 200, "Actual public bootstrap SDK/import map has wrong prefix");
  if (prefix) {
    for (const route of ["/_/api/plugin-host", "/notes-other/_/api/plugin-host"]) {
      const response = await fetch(`${server.baseUrl}${route}`, { signal: AbortSignal.timeout(5000) }); assert(response.status === 404, "Wrong prefix/neighbor admitted"); await response.body?.cancel();
    }
  }
  for (const route of ["/_/plugins/gps08/app.js?v=gps08", "/_/plugins/gps08/client.js"]) assert((await api(route)).status === 200, "Authorized custom-basename module rejected");
  const queried = await api("/_/api/plugins/gps08/query?x=one&x=two");
  assert(queried.status === 200 && JSON.stringify(queried.body.query) === JSON.stringify([["x", "one"], ["x", "two"]]), "Prefix wrapper lost actual query pairs");
  if (mode === "read_only") {
    for (const [route, method, body] of [["/_/api/plugin-host/gps08/settings/preferences", "PUT", { revision: 0, values: { message: "denied" } }], ["/_/api/plugin-host/gps08/commands/consume", "POST", {}], ["/_/api/notes/Seed", "PATCH", { newContent: "denied" }]]) assert((await api(route, method, body)).status === 403, "Read-only mutation escaped admission");
    assert((await api("/_/api/plugins/gps08/counts")).body.commands === 0 && await Deno.readTextFile(`${vault}/Seed.md`) === seed, "Read-only rejection changed Worker/note");
    assert(await privateBytes() === null, "Read-only rejected command persisted private data");
    await session.click('[title="Open sidebar"]'); await session.click('[aria-label="Settings"]'); await session.button("GPS08 preferences");
    await session.poll("document.querySelector('#settings-field-message')?.readOnly===true");
    await session.click('[aria-label="Close settings"]'); await session.click('[title="Close sidebar"]');
    await palette(session); await session.poll("document.querySelector('[data-gps08-consumer]').textContent==='GPS08 default'");
    return { readonlyAdmissions: 3, readonlyBrowserSdkConsumer: true, queries: queried.body.query };
  }
  const message = `GPS08 saved ${current.label}`;
  await session.click('[title="Open sidebar"]'); await session.click('[aria-label="Settings"]'); await session.button("GPS08 preferences");
  await fill(session, "#settings-field-message", message);
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')");
  await session.click('[title="Close sidebar"]');
  const settings = await api("/_/api/plugin-host/gps08/settings/preferences");
  assert(settings.status === 200 && settings.body.revision === 1 && settings.body.values.message === message, "Native prefixed settings commit not acknowledged");
  await palette(session); await session.poll(`document.querySelector('[data-gps08-consumer]').textContent===${JSON.stringify(message)}`);
  if (current.peer) { await palette(current.peer); await current.peer.poll(`document.querySelector('[data-gps08-consumer]').textContent===${JSON.stringify(message)}`); }
  const command = await api("/_/api/plugin-host/gps08/commands/consume", "POST", {});
  assert(command.status === 200 && command.body.result.message === message && command.body.result.commands === 1, "Actual server command did not consume prefixed settings");
  await session.button("Edit", ".content-column"); await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await session.button("WYSIWYG", ".content-column");
  await session.poll("!!document.querySelector('.ProseMirror[contenteditable=true]') && !!window.__gps08Editor");
  assert(await session.evaluate("window.__gps08Runtime.sdk===window.__gps08Editor.sdk && window.__gps08Runtime.milk===window.__gps08Editor.milk && window.__gps08Editor.version===1"), "Actual runtime/editor imports duplicate SDK/package instances");
  const marker = `GPS08 WYSIWYG ${current.label}`;
  await session.click(".ProseMirror"); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type(marker);
  await session.poll(`document.querySelector('.ProseMirror').textContent.includes(${JSON.stringify(marker)})`);
  await session.button("Save", ".content-column");
  await session.poll(`fetch(${JSON.stringify(prefix + "/_/api/notes/Seed")},{headers:{authorization:'Bearer '+(sessionStorage.getItem('token')??'')}}).then(r=>r.json()).then(note=>note.content.includes(${JSON.stringify(marker)}))`);
  const note = (await api("/_/api/notes/Seed")).body, disk = await Deno.readTextFile(`${vault}/Seed.md`);
  assert(note.content === disk && disk.includes(marker), "Actual prefixed native Save lost exact API/disk content");
  let data = JSON.parse(await Deno.readTextFile(`${state}/plugin-data/gps08/data.json`)).values;
  await Deno.writeTextFile(`${directory}/private-hook-first-observation.json`, JSON.stringify(data, null, 2), { createNew: true });
  for (const deadline = Date.now() + 5000; data.saves !== 1 || data.content !== disk;) {
    assert(Date.now() < deadline, "Actual private on-save consumer observation deadline");
    await new Promise(resolve => setTimeout(resolve, 25));
    data = JSON.parse(await Deno.readTextFile(`${state}/plugin-data/gps08/data.json`)).values;
  }
  assert(data.commands === 1 && data.saves === 1 && data.message === message && data.content === disk, "Saved settings/content did not reach real private hook consumer");
  await Deno.writeTextFile(`${directory}/private-hook-consumer.json`, JSON.stringify(data, null, 2), { createNew: true });
  assert(!JSON.stringify((await api("/_/api/plugin-host")).body).includes("GPS08_PRIVATE_PROOF"), "Catalogue leaked private plugin data");
  if (mode === "password") {
    const expiry = Math.floor(Date.now() / 1000) + 2, short = await signed(current.secret, expiry), expired = await stream(short);
    await wait(() => expired.state.closed, 3500); await expired.drained;
    assert(expired.state.text.includes('event: close') && expired.state.text.includes('unauthorized') && !expired.state.text.includes('event: heartbeat'), "Real signed expiry did not close before heartbeat");
    const invalidation = await api("/_/api/plugin-host/gps08/settings/preferences", "PUT", { revision: 1, values: { message: "GPS08 post-expiry invalidation" } });
    assert(invalidation.status === 200 && !expired.state.text.includes('event: invalidate'), "Expired stream received an authorized later invalidation");
    assert((await api("/_/api/plugin-host/events", "GET", undefined, short)).status === 401, "Expired stream reconnected");
    const valid = await stream(current.token), oldToken = current.token;
    const access = (await api("/_/api/access")).body;
    const changed = await api("/_/api/access", "PUT", { mode: "password", username, password: nextPassword, totpEnabled: false, currentPassword: password, revision: access.revision, signature: access.signature, updateId: crypto.randomUUID() });
    assert(changed.status === 200 && changed.body.requiresLogin, "Actual security transition failed");
    await wait(() => valid.state.closed); await valid.drained;
    assert(valid.state.text.includes('policy-change'), "Security transition did not retire valid stream");
    const beforeRejectedPrivate = await privateBytes(), beforeRejectedNote = await Deno.readTextFile(`${vault}/Seed.md`);
    for (const [route, method] of [["/_/plugins/gps08/app.js", "GET"], ["/_/api/plugin-host/events", "GET"], ["/_/api/plugin-host/gps08/commands/consume", "POST"]]) assert((await api(route, method, method === "POST" ? {} : undefined, oldToken)).status === 401, "Retired session reached a current-auth consumer");
    assert(await privateBytes() === beforeRejectedPrivate && await Deno.readTextFile(`${vault}/Seed.md`) === beforeRejectedNote, "Retired credential rejection changed private/note bytes");
    for (const peer of [session, current.peer]) await peer.poll("!window.__gps08Runtime && !document.querySelector('[data-gps08-consumer]') && window.__gps08Disposed===1");
    await session.goto(`${server.baseUrl}${prefix}/Seed`); current.token = await login(session, nextPassword);
    assert((await api("/_/api/plugin-host/gps08/settings/preferences")).body.revision === 2, "Fresh authorization lost persisted settings");
    await Deno.writeTextFile(`${directory}/stream-consumers.json`, JSON.stringify({ expiry, signedExpiryFrames: expired.state.text, securityTransitionFrames: valid.state.text, expiredReconnectStatus: 401, oldCredentialRejections: 3, bothNativeBrowserOwnersDisposed: true, freshNativeLogin: true }), { createNew: true });
  }
  return { actualRuntimeSdk: true, actualEditorSdkIdentity: true, nativeSettings: settings.body, nativeCommand: command.body.result, queryPairs: queried.body.query, exactApiDiskContent: disk, privateHookConsumer: data, independentAuthenticatedPeers: mode === "password" ? 2 : 0 };
}
try {
  for (const prefix of ["", "/notes"]) for (const mode of ["password", "none", "read_only", "setup"]) {
    await fixture(prefix, mode);
    let consumers;
    if (mode === "setup") {
      await current.session.poll("!!document.querySelector('#setup-title')");
      for (const [route, method] of [["/_/plugins/gps08/app.js", "GET"], ["/_/plugins/gps08/client.js", "GET"], ["/_/api/plugin-host/gps08/settings/preferences", "GET"], ["/_/api/plugins/gps08/query?x=one", "GET"], ["/_/api/plugin-host/gps08/commands/consume", "POST"]]) assert((await api(route, method, method === "POST" ? {} : undefined)).status === 503, "Setup gate admitted plugin code/effect");
      assert(!current.server.logs.stdout.includes("GPS08_WORKER_ACTIVATED") && !await current.session.evaluate("!!window.__gps08Runtime || !!window.__gps08Editor"), "Setup ran actual Worker/browser contributions");
      assert(await Deno.readTextFile(`${current.vault}/Seed.md`) === seed, "Setup rejection changed note bytes");
      assert(await privateBytes() === null, "Setup rejection persisted private data");
      consumers = { setupRejections: 5, noWorkerActivation: true, noBrowserRuntime: true, noteRetained: true };
    } else consumers = await configured();
    assert(current.sessions.every(session => session.errors.length === 0), "Prefix/auth page exception");
    const assetResponses = current.wire.filter(row => row.method === "Network.responseReceived" && new URL(row.url).pathname.includes("/_/assets/"));
    assert(assetResponses.length > 0 && assetResponses.every(row => row.status === 200 && new URL(row.url).pathname.startsWith(prefix + "/_/assets/")), "Actual production asset request escaped prefix or failed");
    await Deno.writeTextFile(`${current.directory}/asset-consumers.json`, JSON.stringify({ prefix, assets: assetResponses, allObservedAssets200AtPrefix: true, wire: current.wire }, null, 2), { createNew: true });
    await screenshot(current.session, "outcome");
    await Deno.writeTextFile(`${current.directory}/consumers.json`, JSON.stringify({ label: current.label, prefix, mode, ...consumers, responses: current.responses, pageErrors: current.sessions.flatMap(session => session.errors), events: current.sessions.flatMap(session => session.events) }, null, 2), { createNew: true });
    await closeCurrent(); outcomes.push({ name: current.label, passed: true }); console.log(`ok: GPS08 ${current.label} actual consumers`);
  }
  assert(outcomes.length === 8, "Missing required prefix/auth case"); console.log("GPS-08 PREFIX AUTH OK");
} catch (error) {
  failure = error; console.error(`FAIL: ${error.message}`);
  if (current?.session) {
    await screenshot(current.session, "failure").catch(captureError => console.error(captureError.message));
    await Deno.writeTextFile(`${current.directory}/failure.json`, JSON.stringify({ failure: error.message, responses: current.responses, wire: current.wire, pageErrors: current.sessions.flatMap(session => session.errors), events: current.sessions.flatMap(session => session.events), privateDataBytes: await privateBytes(), page: await current.session.evaluate("({url:location.href,body:document.body.innerText,buffer:document.querySelector('.cm-content')?.textContent??document.querySelector('.ProseMirror')?.textContent,storedTokenPresent:!!sessionStorage.getItem('token'),runtime:!!window.__gps08Runtime,disposed:window.__gps08Disposed??0})").catch(() => null), ownership: { vault: current.vault, state: current.state, serverPid: current.server?.pid, baseUrl: current.server?.baseUrl }, sessions: current.sessions.map(session => ({ targetId: session.targetId, browserContextId: session.browserContextId })) }, null, 2), { createNew: true });
  }
} finally { await closeCurrent(); }
await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({ outcomes, failure: failure?.message, failedFixtureClosedAfterCapture: !!failure && current?.closed }, null, 2), { createNew: true });
if (failure) throw failure;
