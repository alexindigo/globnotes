// Final native clipboard and Access transport/conflict/error consumers.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { hashPassword } from "../../../server/helpers.ts";
import { SignJWT } from "jose";

let options;
try { options = parseArguments(Deno.args); } catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: access-extra-states.mjs --artifacts <directory>"); Deno.exit(0); }
if (!options.artifacts) { console.error("--artifacts is required"); Deno.exit(2); }
const artifacts = options.artifacts; await Deno.mkdir(artifacts, { mode: 0o700 });
const assert = (value, message) => { if (!value) throw Error(message); };
const password = "extra-access-password", username = "extra-access-fixture";
const outcomes = []; let current, failure;
async function wait(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) { assert(Date.now() < end, "Access extra-state observation deadline"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function api(route, method = "GET", body) {
  const response = await fetch(`${current.server.baseUrl}/_/api/${route}`, { method, headers: { ...(current.token ? { authorization: `Bearer ${current.token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function fill(selector, value) {
  const session = current.session; await session.click(selector); await session.poll(`document.activeElement===document.querySelector(${JSON.stringify(selector)}) && !document.activeElement.disabled`);
  await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type(value);
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`);
}
async function fixture(label, protectedMode = false, narrow = false) {
  const directory = `${artifacts}/${label}`; await Deno.mkdir(directory);
  const vault = await Deno.makeTempDir({ prefix: `access-extra-${label}-vault-` }), state = await Deno.makeTempDir({ prefix: `access-extra-${label}-state-` });
  const secret = crypto.randomUUID(); await Deno.writeTextFile(`${vault}/Seed.md`, "Extra-state seed.\n");
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify(protectedMode ? { auth_type: "password", username, password_hash: await hashPassword(password), secret_key: secret } : { auth_type: "none" }));
  const token = protectedMode ? await new SignJWT({ sub: username }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(secret)) : null;
  const server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_AUTO_ENABLE_PLUGINS: "false" }, logsDir: directory, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335), width: narrow ? 360 : 1280, height: narrow ? 640 : 900, dpr: narrow ? 2 : 1 });
  current = { label, directory, vault, state, server, session, token, narrow, protectedMode, writes: [], closed: false };
  await Deno.writeTextFile(`${directory}/ownership.json`, JSON.stringify({ label, vault, state, serverPid: server.pid, baseUrl: server.baseUrl, targetId: session.targetId, browserContextId: session.browserContextId }), { createNew: true });
  await session.goto(`${server.baseUrl}/Seed`);
  if (protectedMode) { await session.poll("!!document.querySelector('#username')"); await fill("#username", username); await fill("#password", password); await session.button("Log In"); }
  await session.poll("!!document.querySelector('.toast-viewer')");
  await session.button("Edit", ".content-column"); await session.button("Source", ".content-column"); await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await session.click(".cm-content"); await session.type(`Retained ${label} buffer\n`);
  await session.poll(`document.querySelector('.cm-content').textContent.includes(${JSON.stringify(label)})`);
  await session.poll("(()=>{const line=document.querySelector('.cm-activeLineGutter')?.textContent.trim();return !!line&&location.hash==='#source:L'+line;})()");
  await session.evaluate("window.__extraEditor=document.querySelector('.cm-content');window.__extraBuffer=window.__extraEditor.textContent;window.__extraUrl=location.href;true");
  if (narrow) {
    await session.click('[title="Open sidebar"]'); await session.click('[aria-label="Settings"]'); await session.button("Appearance"); await session.click('[data-theme-id="globnotes-dark"]');
    await session.click('[aria-label="Close settings"]'); await session.click('[title="Close sidebar"]');
  }
  current.original = await Deno.readTextFile(`${state}/config.json`);
  session.page.onEvent(event => { if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PUT" && new URL(event.params.request.url).pathname === "/_/api/access") current.writes.push(event.params.requestId); });
}
async function open(waitForLoaded = true) {
  const s = current.session; if (await s.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await s.click('[title="Open sidebar"]');
  await s.click('[aria-label="Settings"]'); await s.button("Access"); await s.button("Change access mode");
  await s.poll("!!document.querySelector('#setup-title')");
  // The visible wizard initially owns a loading form. Its admitted read also
  // selects the actual mode and focuses the radio, potentially scrolling a
  // narrow viewport. Observe that boundary before any native setting click.
  if (waitForLoaded) {
    await s.poll(`document.querySelector('#setup-mode-${current.protectedMode ? "password" : "none"}')?.checked && document.querySelector('#setup-mode-password')?.disabled===false`);
    await s.evaluate("document.fonts.ready.then(()=>true)");
  }
}
async function capture(label) {
  const s = current.session; await s.evaluate("document.fonts.ready.then(()=>true)");
  const geometry = await s.evaluate("(()=>{const box=document.querySelector('[aria-labelledby=setup-title]'),r=box.getBoundingClientRect();return {url:location.href,body:document.body.innerText,rect:r.toJSON(),overflowX:box.scrollWidth-box.clientWidth,contained:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,editorRetained:document.querySelector('.cm-content')===window.__extraEditor,buffer:document.querySelector('.cm-content')?.textContent};})()");
  assert(geometry.contained && geometry.overflowX <= 1 && geometry.editorRetained, "Extra Access state escaped/lost its owner");
  const { data } = await s.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${current.directory}/${label}.png`, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { createNew: true });
  await Deno.writeTextFile(`${current.directory}/${label}.json`, JSON.stringify(geometry, null, 2), { createNew: true });
}
async function retained() {
  assert(await current.session.evaluate("document.querySelector('.cm-content')===window.__extraEditor && document.querySelector('.cm-content').textContent===window.__extraBuffer && location.href===window.__extraUrl"), "Extra Access state discarded the literal editor buffer/URL");
}
async function close() {
  if (!current || current.closed) return;
  await current.session.close(); await current.server.close(); current.closed = true;
  await Deno.writeTextFile(`${current.directory}/closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true, generatedFilesRetained: true }), { createNew: true });
}
async function done(consumers) {
  assert(!current.session.errors.length, "Extra Access page exception");
  await Deno.writeTextFile(`${current.directory}/consumers.json`, JSON.stringify({ name: current.label, ...consumers, writes: current.writes.length, pageErrors: current.session.errors, events: current.session.events }, null, 2), { createNew: true });
  await close(); outcomes.push({ name: current.label, passed: true }); console.log(`ok: Access ${current.label}`);
}
try {
  for (const granted of [true, false]) {
    await fixture(granted ? "clipboard-success" : "clipboard-denied", true, !granted); await open();
    const s = current.session;
    await s.browser.send("Browser.setPermission", { permission: { name: "clipboard-write" }, setting: granted ? "granted" : "denied", origin: current.server.baseUrl, browserContextId: s.browserContextId });
    if (granted) await s.browser.send("Browser.setPermission", { permission: { name: "clipboard-read" }, setting: "granted", origin: current.server.baseUrl, browserContextId: s.browserContextId });
    assert(await s.evaluate("navigator.permissions.query({name:'clipboard-write'}).then(permission=>permission.state)") === (granted ? "granted" : "denied"), "Actual clipboard permission differs from owned fixture setting");
    const bundles = []; s.page.onEvent(event => { if (event.method === "Network.responseReceived" && event.params.response.url.endsWith("/access/totp-enrolment")) bundles.push(event.params.requestId); });
    await s.click("#setup-totp"); await s.poll("document.querySelector('#setup-totp-qr img')?.naturalWidth>0");
    assert(bundles.length === 1, "Missing actual enrolment bundle");
    const wire = await s.send("Network.getResponseBody", { requestId: bundles[0] }); const bundle = JSON.parse(wire.base64Encoded ? atob(wire.body) : wire.body);
    await s.click("#setup-totp-qr"); await s.poll("document.querySelector('#setup-totp-copy-feedback')?.textContent.includes('Click again')");
    await s.click("#setup-totp-qr");
    await s.poll(`document.querySelector('#setup-totp-copy-feedback')?.textContent===${JSON.stringify(granted ? "Setup key copied." : "Could not copy the setup key. Please try again.")}`);
    if (granted) assert(await s.evaluate("navigator.clipboard.readText()") === bundle.secret, "Actual clipboard consumer did not receive the minted key");
    const beforeFocus = await s.evaluate("({active:document.activeElement?.id,caption:document.querySelector('#setup-totp-copy-feedback')?.textContent})");
    await capture("second-click-feedback"); await s.click("#access-current-password");
    await Deno.writeTextFile(`${current.directory}/clipboard-focus-observation.json`, JSON.stringify({ before: beforeFocus, after: await s.evaluate("({active:document.activeElement?.id,caption:document.querySelector('#setup-totp-copy-feedback')?.textContent,hit:document.querySelector('#access-current-password')===document.elementFromPoint(...(()=>{const r=document.querySelector('#access-current-password').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})())})") }, null, 2), { createNew: true });
    await s.poll("document.activeElement===document.querySelector('#access-current-password')");
    await s.poll("!document.querySelector('#setup-totp-copy-feedback')");
    await retained(); assert(await Deno.readTextFile(`${current.state}/config.json`) === current.original && (await api("auth-check")).status === 200, "Clipboard flow changed account/session");
    await done({ secondNativeClick: true, actualClipboardMatchesBundle: granted, actualPermission: granted ? "granted" : "denied", feedbackRemovedOnBlur: true, configAndSessionUnchanged: true, literalDirtyBufferRetained: true });
  }
  for (const lost of [false, true]) {
    await fixture(lost ? "lost-receipt-review" : "unknown-held-wire", false, lost); await open();
    const s = current.session, gate = { held: null };
    s.page.onEvent(event => {
      if (event.method !== "Fetch.requestPaused") return;
      if (event.params.request.method === "PUT") gate.held = event.params;
      else s.send("Fetch.continueRequest", { requestId: event.params.requestId }).catch(() => {});
    });
    await s.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/access", requestStage: "Response" }] });
    await s.click("#setup-read-only-settings"); await s.click("#setup-ack"); await s.button("Save access settings");
    await s.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')"); await s.button("Save", '[data-modal-top="true"]');
    await wait(() => !!gate.held); assert(gate.held.responseStatusCode === 200, "Unknown-wire operation did not really commit upstream");
    const saved = JSON.parse(await Deno.readTextFile(`${current.state}/config.json`)); assert(saved.read_only_settings === true && saved.access_update_id, "Actual lock/receipt missing from disk");
    if (lost) await s.send("Fetch.failRequest", { requestId: gate.held.requestId, errorReason: "ConnectionClosed" });
    await s.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('outcome is unknown')");
    await retained(); await capture("unknown-state");
    assert(current.writes.length === 1, "Unknown operation replayed");
    if (lost) {
      await s.poll("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Review current access')?.disabled===false"); await s.button("Review current access");
    } else {
      assert(await s.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Review current access').disabled"), "In-flight unknown wire allowed review");
      await s.click('[aria-label="Dismiss setup"]'); assert(await s.evaluate("!!document.querySelector('#setup-title')"), "Unknown wire dismissed its owner");
      await s.send("Fetch.continueRequest", { requestId: gate.held.requestId });
    }
    await s.poll("!document.querySelector('#setup-title')"); await s.send("Fetch.disable"); await retained();
    assert((await api("config")).body.settingsWritable === false && current.writes.length === 1, "Unknown recovery did not consume actual policy without replay");
    assert((await Deno.readTextFile(`${current.vault}/Seed.md`)).includes(current.label), "Authorized handoff Save did not persist the retained literal buffer");
    await done({ actualCommittedLockAndReceipt: true, unknownStateRendered: true, retainedOwnerAndBuffer: true, replayedWrites: 0, explicitReview: lost, actualPolicyConsumer: false });
  }
  await fixture("stale-cas", false, true); await open();
  const view = (await api("access")).body;
  const concurrent = await api("access", "PUT", { mode: "none", readOnlySettings: false, revision: view.revision, signature: view.signature, updateId: crypto.randomUUID() }); assert(concurrent.status === 200, "Concurrent writer did not commit");
  await current.session.click("#setup-read-only-settings"); await current.session.click("#setup-ack"); await current.session.button("Save access settings");
  await current.session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')"); await current.session.button("Save", '[data-modal-top="true"]');
  await current.session.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('Access settings changed')");
  await retained(); await capture("stale-response");
  assert(await current.session.evaluate("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')==='true'") && (await api("config")).body.settingsWritable, "Stale error lost proposed choice or overwrote concurrent policy");
  await done({ actualStaleMutationRejected: true, currentChoicesRetained: true, editorBufferRetained: true, concurrentPolicyRetained: true });
  await fixture("load-error", false);
  const s = current.session;
  s.page.onEvent(event => { if (event.method === "Fetch.requestPaused") s.send("Fetch.fulfillRequest", { requestId: event.params.requestId, responseCode: 503, responseHeaders: [{ name: "content-type", value: "application/json" }], body: btoa(JSON.stringify({ detail: "Fixture access read unavailable" })) }).catch(() => {}); });
  await s.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/access", requestStage: "Response" }] }); await open(false);
  await s.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('Fixture access read unavailable')");
  assert(await s.evaluate("document.querySelector('[aria-labelledby=setup-title] button[type=submit]').disabled"), "Failed initial access read allowed submission");
  await retained(); await capture("read-error"); assert(await Deno.readTextFile(`${current.state}/config.json`) === current.original, "Read error changed configuration");
  await s.send("Fetch.disable"); await s.click('[aria-label="Dismiss setup"]'); await s.poll("!document.querySelector('#setup-title')"); await retained();
  await done({ realReadResponseFailureRendered: true, submitUnavailable: true, configurationUnchanged: true, literalDirtyBufferRetained: true });
  assert(outcomes.length === 6, "Missing extra Access state"); console.log("ACCESS EXTRA STATES OK (six actual consumers)");
} catch (error) {
  failure = error; console.error(error.stack ?? error);
  if (current) await Deno.writeTextFile(`${current.directory}/failure.json`, JSON.stringify({ error: error.message, writes: current.writes.length, pageErrors: current.session.errors, events: current.session.events, page: await current.session.evaluate("({url:location.href,body:document.body.innerText,buffer:document.querySelector('.cm-content')?.textContent})").catch(() => null) }, null, 2), { createNew: true });
  if (current) await capture("failure").catch(() => {});
} finally { await close(); }
await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({ outcomes, failure: failure?.message, failedFixtureClosedAfterCapture: !!failure && current?.closed }), { createNew: true });
if (failure) throw failure;
