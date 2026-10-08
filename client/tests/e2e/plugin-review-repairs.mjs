// VM-only production consumers for the seven browser/Settings repair groups.
// Transport and plugin-owned module barriers order real application work; they
// never replace a controller, a response, the registry or its ownership logic.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { hashPassword } from "../../../server/helpers.ts";
import { authenticatorCode } from "../../../tests/helpers/totp.ts";

const options = parseArguments(Deno.args);
if (options.help) { console.log("Usage: plugin-review-repairs.mjs --artifacts <directory>"); Deno.exit(0); }
if (!options.artifacts) throw Error("--artifacts is required");
const artifacts = options.artifacts;
await Deno.mkdir(artifacts, { mode: 0o700 });
const assert = (value, detail) => { if (!value) throw Error(detail); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const outcomes = [], fixtures = [];
const password = "review-fixture-current-password", username = "review-fixture";
const cdpPort = Number(Deno.env.get("CDP_PORT"));
assert(Number.isSafeInteger(cdpPort) && cdpPort > 0, "Verified owned CDP_PORT required");
let current;

async function until(predicate, detail, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { assert(Date.now() < end, detail); await delay(30); }
}
async function sessionAt(base) {
  const session = await nativeSession({ port: cdpPort }); current.sessions.push(session);
  await session.goto(`${base}/Seed`);
  if (current.protectedAccount) {
    await session.poll("!!document.querySelector('#username')");
    await fill(session, "#username", username); await fill(session, "#password", password);
    await session.button("Log In");
  }
  await session.poll("!!document.querySelector('.toast-viewer')");
  return session;
}
async function fill(session, selector, value) {
  // Admit native input only after rendered hit-testing is ready, as in the
  // existing production-native input adapters. Never bypass an overlay.
  await session.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  await session.poll(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input||input.disabled||input.closest('[inert]'))return false;input.scrollIntoView({block:'center',inline:'center'});const r=input.getBoundingClientRect();return r.width>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input;})()`);
  await session.click(selector);
  await session.poll(`document.activeElement===document.querySelector(${JSON.stringify(selector)}) && !document.activeElement.disabled && !document.activeElement.closest('[inert]')`);
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 });
  if (value) await session.type(value);
  else await session.key("Backspace", { code: "Backspace", windowsVirtualKeyCode: 8 });
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`);
}
async function settings(session, page = "Plugins") {
  if (!await session.evaluate("!!document.querySelector('[aria-label=Settings]')?.getBoundingClientRect().width")) await session.click('[title="Open sidebar"]');
  await session.click('[aria-label="Settings"]');
  await session.button(page, '[aria-label="Settings pages"]');
  await session.poll("!!document.querySelector('#settings-modal-title')");
}
async function access(session) { await settings(session, "Access"); await session.button("Change access mode"); await session.poll("!!document.querySelector('#setup-title') && !document.querySelector('#setup-mode-password').disabled"); }
async function closeSettings(session) { await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')"); }
async function api(path, method = "GET", body, session) {
  const token = session ? await session.evaluate("sessionStorage.getItem('token')||localStorage.getItem('token')") : null;
  const response = await fetch(`${current.server.baseUrl}/_/api/${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}
const catalog = async session => { const result = await api("plugin-host", "GET", undefined, session); assert(result.status === 200, "Actual catalogue read rejected"); return result.body; };
async function finishPeerPolicy(expected, unavailable) {
  const peer = current.peer;
  await peer.poll(`(${expected}) && ((${unavailable})===false || [...document.querySelectorAll('[data-inventory-recovery] button')].some(button=>button.textContent.trim()==='Review current policy'&&!button.disabled))`);
  if (await peer.evaluate(unavailable)) {
    // A real SSE publication can supersede the PUT's follow-up read. The
    // committed choice requires a separate explicit Review, never another PUT.
    const writes = current.peerPolicyWrites;
    await peer.button("Review current policy", '[data-inventory-recovery]');
    await peer.poll("!document.querySelector('[data-inventory-recovery]')");
    assert(current.peerPolicyWrites === writes, "Explicit committed-policy Review replayed a policy write");
  }
  await peer.poll(`(${expected}) && (${unavailable})===false`);
}
async function togglePeer(enabled) {
  const peer = current.peer;
  if (!await peer.evaluate("!!document.querySelector('#settings-modal-title')")) await settings(peer);
  await peer.poll(`document.querySelector('[data-plugin-inventory-id=review] button')?.textContent.trim()===${JSON.stringify(enabled ? "Disabled" : "Enabled")} && !document.querySelector('[data-plugin-inventory-id=review] button').disabled`);
  await peer.click('[data-plugin-inventory-id="review"] button');
  await finishPeerPolicy(`document.querySelector('[data-plugin-inventory-id=review] button')?.textContent.trim()===${JSON.stringify(enabled ? "Enabled" : "Disabled")}`, "document.querySelector('[data-plugin-inventory-id=review] button')?.disabled");
}
function gateResponse(method, path) {
  assert(!current.nextGate, "Overlapping fixture transport admission");
  const gate = { method, path, response: null, released: false, ready: Promise.withResolvers(), release: Promise.withResolvers() };
  current.nextGate = gate; current.gates.push(gate); return gate;
}
async function release(gate) { gate.released = true; gate.release.resolve(); }
async function fixture(label, { protectedAccount = false, browser = false } = {}) {
  assert(fixtures.every(value => value.closed), "Previous successful fixture not closed");
  const directory = `${artifacts}/${label}`, vault = `${directory}/vault`, state = `${directory}/state`, pluginDir = `${state}/plugins/review`;
  await Deno.mkdir(vault, { recursive: true }); await Deno.mkdir(pluginDir, { recursive: true });
  await Deno.writeTextFile(`${vault}/Seed.md`, "Review seed.\n");
  const config = protectedAccount ? { auth_type: "password", username, password_hash: await hashPassword(password), secret_key: crypto.randomUUID(), unrelated_fixture: { retained: true } } : { auth_type: "none" };
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify(config));
  const descriptor = key => ({ id: "preferences", label: "Repair preferences", renderer: { kind: "declarative-v1", version: 1 }, fields: [{ key, label: key.toUpperCase(), type: "text", default: `${key}-default` }] });
  const manifest = { id: "review", name: "Review fixture", runtime: { server: "service.js", ...(browser ? { client: "browser.js" } : {}) }, capabilities: { network: false, imports: false, read: [], write: [] }, settings: [descriptor("message")] };
  await Deno.writeTextFile(`${pluginDir}/manifest.json`, JSON.stringify(manifest));
  await Deno.writeTextFile(`${pluginDir}/service.js`, `const owner=crypto.randomUUID();export function activate(ctx){ctx.commands.register({id:'inspect',label:'Inspect repair fixture',target:'server'},()=>({owner}));ctx.commands.register({id:'request',label:'Request repair scope',target:'server'},async()=>{const view=await ctx.permissions.status();return ctx.permissions.requestAccess({kind:'network',hosts:['127.0.0.1:9'],reason:'Repair prompt fixture'},{source:view.source});});}`);
  await Deno.writeTextFile(`${state}/plugins.json`, JSON.stringify({ enabled: ["review"], autoEnable: false }));
  current = { label, directory, vault, state, pluginDir, manifest, descriptor, config, protectedAccount, sessions: [], gates: [], browserHolds: [], requests: [], closed: false };
  fixtures.push(current);
  if (browser) await browserCode("seed");
  // A real login token is acquired by the browser; boot readiness can use a
  // fixture-local signed token, solely to observe the normal protected parent.
  let headers = {};
  if (protectedAccount) {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ sub: username }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(config.secret_key));
    headers = { authorization: `Bearer ${token}` };
  }
  current.server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_AUTO_ENABLE_PLUGINS: "" }, logsDir: directory, headers });
  const owner = current;
  current.proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async request => {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/browser-A") {
      const barrier = Promise.withResolvers(); owner.browserHolds.push(barrier); await barrier.promise;
      return new Response("release old activation");
    }
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
    const response = await fetch(`${owner.server.baseUrl}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: "manual" });
    owner.requests.push({ method: request.method, path: url.pathname, status: response.status, at: Date.now() });
    const gate = owner.nextGate;
    if (gate?.method === request.method && gate.path === url.pathname) {
      owner.nextGate = null;
      const bytes = await response.arrayBuffer(); gate.response = { status: response.status, body: new TextDecoder().decode(bytes), at: Date.now() }; gate.ready.resolve();
      await gate.release.promise;
      return new Response(bytes, { status: response.status, headers: response.headers });
    }
    return new Response(response.body, { status: response.status, headers: response.headers });
  });
  current.entryBase = `http://127.0.0.1:${current.proxy.addr.port}`;
  current.session = await sessionAt(current.entryBase);
  current.peer = await sessionAt(current.server.baseUrl);
  current.peerPolicyWrites = 0;
  current.peer.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PUT" && /^\/_\/api\/plugin-host\/(?:policy|review\/enabled)$/.test(new URL(event.params.request.url).pathname)) current.peerPolicyWrites++;
  });
  await Deno.writeTextFile(`${directory}/ownership.json`, JSON.stringify({ label, vault, state, serverPid: current.server.pid, baseUrl: current.server.baseUrl, entryBase: current.entryBase,
    contexts: current.sessions.map(session => ({ targetId: session.targetId, browserContextId: session.browserContextId })) }, null, 2), { createNew: true });
}
async function browserCode(kind) {
  await Deno.writeTextFile(`${current.pluginDir}/browser.js`, `export async function activate(ctx){
    const kind=${JSON.stringify(kind)}, nonce=crypto.randomUUID();
    const marker=document.createElement('output');marker.dataset.reviewOwner=kind;marker.dataset.nonce=nonce;marker.dataset.events='0';marker.dataset.commands='0';marker.hidden=true;document.body.append(marker);ctx.register(()=>marker.remove());
    ctx.commands.register({id:'inspect-browser',label:'Inspect browser repair',target:'browser'},()=>{marker.dataset.commands=String(Number(marker.dataset.commands)+1);return {kind,nonce};});
    ctx.events.on('note:save',()=>{marker.dataset.events=String(Number(marker.dataset.events)+1);});
    if(kind==='A'){
      await fetch('/fixture/browser-A');
      const audit=document.createElement('output');audit.dataset.retiredAudit='A';audit.hidden=true;document.body.append(audit);
      let denied=0;for(const create of [()=>ctx.commands.register({id:'ghost',label:'Ghost retired command'},()=>{}),()=>ctx.events.on('note:save',()=>{audit.dataset.ghostEvent='1';}),()=>ctx.timers.setTimeout(()=>{audit.dataset.ghostTimer='1';},0),()=>ctx.timers.setInterval(()=>{audit.dataset.ghostInterval='1';},10)]){try{create();}catch{denied++;}}audit.dataset.denied=String(denied);
      throw Error('owned old activation failure');
    }
  }`);
}
async function capture(label) {
  const session = current.session;
  await session.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${current.directory}/${label}.png`, Uint8Array.from(atob(screenshot.data), ch => ch.charCodeAt(0)));
  const geometry = await session.evaluate("({url:location.href,focus:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('[role=dialog]')].map(el=>({title:el.getAttribute('aria-labelledby'),rect:el.getBoundingClientRect().toJSON(),inert:!!el.closest('[inert]')})),text:document.body.innerText})");
  await Deno.writeTextFile(`${current.directory}/${label}.json`, JSON.stringify(geometry, null, 2), { createNew: true });
}
async function outcome(group, consumers) {
  assert(!outcomes.some(row => row.group === group), "Duplicate repair group");
  outcomes.push({ group, passed: true, fixture: current.label, consumers });
  await Deno.writeTextFile(`${artifacts}/outcomes.json`, JSON.stringify(outcomes, null, 2)); console.log(`ok: ${group}`);
}
async function finish() {
  assert(current.gates.every(gate => gate.released), "Successful fixture has an unresolved transport gate");
  for (const session of current.sessions) { assert(!session.errors.length, "Unexpected production page exception"); await session.close(); }
  await current.proxy.shutdown(); await current.server.close(); current.closed = true;
  await Deno.writeTextFile(`${current.directory}/closure.json`, JSON.stringify({ serverClosed: true, ownedContextsClosed: true, rootsRetained: true, requests: current.requests }, null, 2), { createNew: true });
}

try {
  await fixture("inventory-handoff", { protectedAccount: true });
  await settings(current.session);
  const token = await current.session.evaluate("sessionStorage.getItem('token')"), gate = gateResponse("PUT", "/_/api/plugin-host/review/enabled");
  await current.session.click('[data-plugin-inventory-id="review"] button'); await until(() => gate.response, "Inventory PUT not reached");
  assert(gate.response.status === 200 && !(await catalog(current.session)).plugins.find(plugin => plugin.id === "review").enabled, "Held inventory PUT did not persist upstream");
  await current.session.click('[aria-label="Close settings"]');
  await current.session.poll("document.querySelector('[data-plugin-inventory] [role=alert]')?.textContent.includes('unknown')");
  await current.session.button("Access", '[aria-label="Settings pages"]'); await delay(5200);
  await current.session.button("Account", '[aria-label="Settings pages"]'); await delay(5200);
  assert(await current.session.evaluate(`!!document.querySelector('[data-plugin-inventory]') && !document.querySelector('#setup-title') && sessionStorage.getItem('token')===${JSON.stringify(token)}`), "Unresolved policy admitted a page/session handoff");
  await capture("inventory-unknown-retained"); await release(gate);
  await current.session.poll("!document.querySelector('[data-plugin-inventory] [role=alert]') && !document.querySelector('[data-inventory-recovery]')");
  assert(await current.session.evaluate(`!!document.querySelector('[data-plugin-inventory]') && sessionStorage.getItem('token')===${JSON.stringify(token)}`), "Late ACK resumed an aborted close/page transition");
  const policy = JSON.parse(await Deno.readTextFile(`${current.state}/plugins.json`));
  assert(policy.disabled.includes("review") && current.requests.filter(row => row.method === "PUT" && row.path.endsWith("/enabled")).length === 1, "Inventory policy was replayed or not stored");
  await outcome("inventory handoff", { policy, upstreamStatus: gate.response.status, oneWrite: true, protectedSessionRetained: true, lateHandoffNotResumed: true }); await finish();

  await fixture("access-conflict", { protectedAccount: true });
  await access(current.session); await fill(current.session, "#setup-password", "review-fixture-new-password");
  const bundles = [];
  const removeBundle = current.session.page.onEvent(event => { if (event.method === "Network.responseReceived" && event.params.response.url.endsWith("/access/totp-enrolment")) bundles.push(event.params.requestId); });
  await current.session.click("#setup-totp"); await current.session.poll("!!document.querySelector('#setup-totp-qr img')");
  const response = await current.session.send("Network.getResponseBody", { requestId: bundles[0] });
  const bundle = JSON.parse(response.base64Encoded ? atob(response.body) : response.body);
  await fill(current.session, "#setup-totp-code", await authenticatorCode(bundle.secret, Date.now()));
  await fill(current.session, "#access-current-password", password);
  await access(current.peer); await fill(current.peer, "#access-current-password", password); await current.peer.button("Save access settings");
  await current.peer.poll("!document.querySelector('#setup-title')");
  const before = await Deno.readTextFile(`${current.state}/config.json`);
  await current.session.button("Save access settings");
  await current.session.poll("[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Review current access') && document.querySelector('[aria-labelledby=setup-title] button[type=submit]').disabled");
  assert(await Deno.readTextFile(`${current.state}/config.json`) === before, "Conflicted Access changed stored credentials");
  await capture("access-conflict-review"); await current.session.button("Review current access");
  await current.session.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('Current access reviewed')");
  assert(await current.session.evaluate("document.querySelector('#setup-password').value==='review-fixture-new-password' && !!document.querySelector('#setup-totp-qr img')"), "Review discarded proposal or bundle");
  assert(bundles.length === 1 && current.requests.filter(row => row.method === "PUT" && row.path === "/_/api/access").length === 1, "Review minted/replayed Access work");
  const oldToken = await current.session.evaluate("sessionStorage.getItem('token')");
  const confirmed = await authenticatorCode(bundle.secret, Date.now()); await fill(current.session, "#setup-totp-code", confirmed);
  await current.session.button("Save access settings"); await current.session.poll("!!document.querySelector('#username') && !document.querySelector('#setup-title')");
  const stored = JSON.parse(await Deno.readTextFile(`${current.state}/config.json`));
  assert(stored.auth_type === "totp" && stored.username === username && stored.totp_key === bundle.key && stored.unrelated_fixture.retained && stored.access_revision === 2, "Reviewed explicit Access Save did not reach stored account");
  const oldCheck = await fetch(`${current.server.baseUrl}/_/api/auth-check`, { headers: { authorization: `Bearer ${oldToken}` } }); await oldCheck.body?.cancel(); assert(oldCheck.status === 401, "Old session survived confirmed Access update");
  if (await current.session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width")) await current.session.click('[title="Close sidebar"]');
  await current.session.poll("!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width");
  await fill(current.session, "#username", username); await fill(current.session, "#password", "review-fixture-new-password");
  const now = Date.now(), codes = await Promise.all([now - 30000, now, now + 30000].map(time => authenticatorCode(bundle.secret, time)));
  await fill(current.session, "#one-time-code", codes.find(code => code !== confirmed)); await current.session.button("Log In");
  await current.session.poll("!document.querySelector('#username')");
  assert((await api("auth-check", "GET", undefined, current.session)).status === 200, "Confirmed proposed credentials cannot log in");
  // Access deliberately routes to login without a resource redirect; the real
  // login consumer returns Home. Navigate to the fixture note for its viewer.
  await current.session.goto(`${current.entryBase}/Seed`); await current.session.poll("!!document.querySelector('.toast-viewer')");
  removeBundle(); await outcome("Access conflict recovery", { conflictedBytesRetained: true, reviewedRevision: 1, finalRevision: stored.access_revision, retainedBundle: true, separateSaves: 2, oldSessionStatus: 401, confirmedLoginStatus: 200 }); await finish();

  await fixture("browser-ownership", { browser: true });
  await current.session.poll("!!document.querySelector('[data-review-owner=seed]')");
  await settings(current.session, "Keybindings"); await current.session.button("Obsidian"); await closeSettings(current.session);
  await togglePeer(false); await current.session.poll("!document.querySelector('[data-review-owner=seed]')");
  await browserCode("A"); await togglePeer(true); await until(() => current.browserHolds.length === 1, "Old browser activation did not enter module barrier");
  await togglePeer(false); await current.session.poll("!document.querySelector('[data-review-owner=A]')");
  await browserCode("B"); await togglePeer(true); await current.session.poll("!!document.querySelector('[data-review-owner=B]')");
  const nonce = await current.session.evaluate("document.querySelector('[data-review-owner=B]').dataset.nonce");
  current.browserHolds[0].resolve(); await current.session.poll("document.querySelector('[data-retired-audit=A]')?.dataset.denied==='4'"); await delay(150);
  // Open and run the actual palette command via its native input/selection.
  await current.session.key("p", { modifiers: 2, code: "KeyP", windowsVirtualKeyCode: 80 });
  await current.session.poll("!!document.querySelector('#command-palette-title')");
  await fill(current.session, 'input[placeholder="Type a command…"]', "Inspect browser repair"); await current.session.key("Enter", { code: "Enter", windowsVirtualKeyCode: 13 });
  await current.session.poll("document.querySelector('[data-review-owner=B]')?.dataset.commands==='1'");
  if (await current.session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width")) await current.session.click('[title="Close sidebar"]');
  await current.session.button("Edit", ".content-column"); await current.session.button("Source", ".content-column");
  await current.session.click(".cm-content"); await current.session.type("Browser replacement consumer\n"); await current.session.button("Save", ".content-column");
  await current.session.poll("document.querySelector('[data-review-owner=B]')?.dataset.events==='1'");
  assert((await Deno.readTextFile(`${current.vault}/Seed.md`)).includes("Browser replacement consumer"), "Replacement subscription probe has no actual saved note");
  const actual = await current.session.evaluate("({nonce:document.querySelector('[data-review-owner=B]')?.dataset.nonce,commands:document.querySelector('[data-review-owner=B]')?.dataset.commands,events:document.querySelector('[data-review-owner=B]')?.dataset.events,old:!!document.querySelector('[data-review-owner=A]'),audit:{...document.querySelector('[data-retired-audit=A]').dataset}})");
  assert(actual.nonce === nonce && !actual.old && !actual.audit.ghostEvent && !actual.audit.ghostTimer && !actual.audit.ghostInterval, "Retired activation affected B or created ghost delivery");
  await outcome("A/B activation", { nonce, commandExecutions: actual.commands, realSaveEvents: actual.events, oldOwnerRemoved: true });
  await outcome("retired registration", { deniedCreates: Number(actual.audit.denied), ghostDeliveries: 0, savedNoteObservedByB: true });

  const reversed = gateResponse("GET", "/_/api/plugin-host");
  const autoIcon = "[...document.querySelectorAll('[data-plugin-inventory] button')].find(button=>button.textContent.trim()==='Auto-enable new plugins')?.querySelector('path')?.getAttribute('d')";
  const autoDisabled = "[...document.querySelectorAll('[data-plugin-inventory] button')].find(button=>button.textContent.trim()==='Auto-enable new plugins')?.disabled";
  const offIcon = await current.peer.evaluate(autoIcon); assert(offIcon, "Rendered auto-enable icon missing");
  await current.peer.button("Auto-enable new plugins", '[data-plugin-inventory]'); await until(() => reversed.response, "Old catalogue response not held");
  await finishPeerPolicy(`${autoIcon}!==${JSON.stringify(offIcon)}`, autoDisabled);
  await current.peer.button("Auto-enable new plugins", '[data-plugin-inventory]');
  await finishPeerPolicy(`${autoIcon}===${JSON.stringify(offIcon)}`, autoDisabled);
  const newest = await catalog();
  await settings(current.session); await current.session.poll(`${autoIcon}===${JSON.stringify(offIcon)}`);
  await release(reversed); await delay(250);
  assert(await current.session.evaluate(`document.querySelector('[data-review-owner=B]')?.dataset.nonce===${JSON.stringify(nonce)} && ${autoIcon}===${JSON.stringify(offIcon)}`), "Reverse reply regressed current policy/browser owner");
  await capture("reversed-catalogue-current");
  await outcome("reversed catalogue", { heldRevision: JSON.parse(reversed.response.body).policy.revision, latestRevision: newest.policy.revision, effectiveAutoEnable: false, nonceRetained: nonce }); await finish();

  await fixture("descriptor-settlement"); await settings(current.session, "Repair preferences");
  await current.session.poll("!!document.querySelector('#settings-field-message') && !document.querySelector('#settings-field-message').readOnly");
  const settingsGate = gateResponse("PUT", "/_/api/plugin-host/review/settings/preferences");
  await fill(current.session, "#settings-field-message", "D1 actual proposal"); await current.session.key("Enter", { code: "Enter", windowsVirtualKeyCode: 13 }); await until(() => settingsGate.response, "Settings PUT not held");
  assert(settingsGate.response.status === 200, "D1 did not actually persist");
  for (const key of ["d2", "d3"]) {
    await togglePeer(false);
    current.manifest.settings = [current.descriptor(key)]; await Deno.writeTextFile(`${current.pluginDir}/manifest.json`, JSON.stringify(current.manifest));
    await togglePeer(true);
    await until(async () => (await catalog()).plugins.find(plugin => plugin.id === "review").pages[0].fields[0].key === key, "Latest declared schema not installed");
  }
  assert(await current.session.evaluate("document.querySelector('#settings-field-message')?.value==='D1 actual proposal'"), "Definition replacement discarded D1 owner before settlement");
  await release(settingsGate); await current.session.poll("document.querySelector('#settings-field-d3')?.value==='d3-default' && !document.querySelector('#settings-field-d3').readOnly && !document.querySelector('#settings-field-message')");
  await fill(current.session, "#settings-field-d3", "D3 explicit consumer"); await current.session.key("Enter", { code: "Enter", windowsVirtualKeyCode: 13 });
  await until(async () => (await api("plugin-host/review/settings/preferences")).body.values.d3 === "D3 explicit consumer", "New-schema explicit commit did not persist");
  const storedSettings = JSON.parse(await Deno.readTextFile(`${current.state}/plugin-data/review/settings.json`));
  assert(JSON.stringify(storedSettings).includes("D3 explicit consumer"), "New schema has no actual disk consumer");
  assert(storedSettings.values.preferences.message === "D1 actual proposal", "New-schema save discarded the removed D1 field's stored data");
  await capture("descriptor-d3-authoritative"); await outcome("descriptor ACK/adoption", { latestDefinition: "d3", oldACKNotUsedAsNewData: true, authoritativeDefaultLoaded: true, explicitNewValue: "D3 explicit consumer", removedD1ValueRetained: true, storedSettings }); await finish();

  await fixture("postponed-prompt"); await settings(current.session, "Access");
  const permissionGate = gateResponse("GET", "/_/api/plugin-host/review/permissions");
  assert((await api("plugin-host/review/commands/request", "POST", {})).status === 200, "Actual server request not admitted");
  await until(() => permissionGate.response, "Automatic permission load not reached");
  await current.session.button("Change access mode");
  // Complete the wizard's own Access GET and mounted initial-focus admission
  // before measuring whether the separately held permission reply moves it.
  await current.session.poll("!!document.querySelector('#setup-title') && !document.querySelector('#setup-mode-password').disabled && document.activeElement?.id==='setup-mode-password' && document.querySelector('[data-modal-top=true] [aria-labelledby=setup-title]')?.contains(document.activeElement)");
  const beforeFocus = await current.session.evaluate("({id:document.activeElement?.id,wizardOwnsFocus:document.querySelector('[data-modal-top=true] [aria-labelledby=setup-title]')?.contains(document.activeElement),promptPresent:!!document.querySelector('#permission-request-title')})");
  await Deno.writeTextFile(`${current.directory}/wizard-focus-before.json`, JSON.stringify(beforeFocus, null, 2), { createNew: true });
  const focus = beforeFocus.id;
  await release(permissionGate); await delay(200);
  const afterFocus = await current.session.evaluate("({id:document.activeElement?.id,wizardOwnsFocus:document.querySelector('[data-modal-top=true] [aria-labelledby=setup-title]')?.contains(document.activeElement),promptPresent:!!document.querySelector('#permission-request-title')})");
  await Deno.writeTextFile(`${current.directory}/wizard-focus-after.json`, JSON.stringify(afterFocus, null, 2), { createNew: true });
  assert(!afterFocus.promptPresent && afterFocus.wizardOwnsFocus && afterFocus.id === focus, "Late automatic load overtook wizard/focus");
  await capture("prompt-postponed-behind-access");
  await current.session.click('[aria-label="Dismiss setup"]'); await current.session.poll("!!document.querySelector('#permission-request-title')");
  const pending = (await api("plugin-host/review/permissions")).body;
  assert(pending.pendingRequests.length === 1 && !pending.approvedNetwork.length && !pending.allowNetwork && current.requests.filter(row => row.method === "POST" && row.path.includes("/decision")).length === 0, "Postponement deferred/denied/granted server state");
  assert(current.requests.filter(row => row.method === "GET" && row.path.endsWith("/permissions")).length >= 2, "Prompt reused cached failed/superseded admission");
  await capture("prompt-fresh-focus-owner"); await outcome("postponed prompt", { requestId: pending.pendingRequests[0].id, noDecisionWrites: true, noApproval: true, wizardFocusRetained: true, freshAcceptedLoad: true }); await finish();

  assert(outcomes.length === 7 && outcomes.every(row => row.passed), "Incomplete native repair groups");
  await Deno.writeTextFile(`${artifacts}/summary.json`, JSON.stringify({ complete: true, outcomes, retainedRoots: fixtures.map(value => value.directory) }, null, 2), { createNew: true });
  console.log("PLUGIN REVIEW REPAIRS OK (7 repair groups)");
} catch (error) {
  await Deno.writeTextFile(`${artifacts}/failure.json`, JSON.stringify({ failure: error.stack, outcomes, current: current && { label: current.label, directory: current.directory, vault: current.vault, state: current.state, serverPid: current.server?.pid, entryBase: current.entryBase,
    sessions: current.sessions.map(session => ({ targetId: session.targetId, browserContextId: session.browserContextId })), unresolvedGates: current.gates.filter(gate => !gate.released).map(gate => ({ method: gate.method, path: gate.path, response: gate.response })) } }, null, 2), { createNew: true });
  console.error(`Retained native repair failure: ${error.message}; ${artifacts}/failure.json`);
  // Preserve original wires, children and targets for evidence-backed recovery.
  for (;;) await delay(1000);
}
