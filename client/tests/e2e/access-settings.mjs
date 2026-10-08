// Feature-owned native access consumers; shared browser/runner helpers unchanged.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { hashPassword } from "../../../server/helpers.ts";
import { authenticatorCode } from "../../../tests/helpers/totp.ts";
import { SignJWT } from "jose";
import { createSettingsRestartFixture } from "./settings-restart-fixture.mjs";
import { exerciseLockedControls } from "./access-lock-controls-native.mjs";

let options;
try { options = parseArguments(Deno.args); } catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: access-settings.mjs [--artifacts <directory>] [--help]"); Deno.exit(0); }
const artifacts = options.artifacts ?? await Deno.makeTempDir({ prefix: "access-settings-native-" });
if (options.artifacts) await Deno.mkdir(artifacts, { mode: 0o700 });
const outcomes = [], fixtures = [];
let owned, failure;
const assert = (value, message) => { if (!value) throw Error(message); };
const port = Number(Deno.env.get("CDP_PORT") ?? 9334);
const username = "access-fixture", password = "current-fixture-password";
const ROOT = new URL("../../..", import.meta.url).pathname;
async function bootFirstRun(vault, state, directory, prefix) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 }), port = listener.addr.port; listener.close();
  const child = new Deno.Command(Deno.execPath(), { args: ["run", "--cached-only", "--frozen", `--config=${ROOT}/deno.json`, "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", `${ROOT}/server/main.ts`], cwd: ROOT, clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "", NO_COLOR: "1", GLOBNOTES_PATH: vault, GLOBNOTES_INDEX_PATH: state, GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_AUTO_ENABLE_PLUGINS: "false", GLOBNOTES_PATH_PREFIX: prefix, GLOBNOTES_HOST: "127.0.0.1", GLOBNOTES_PORT: String(port) }, stdout: "piped", stderr: "piped" }).spawn();
  await Deno.writeTextFile(`${directory}/startup-ownership.json`, JSON.stringify({ pid: child.pid, vault, state, prefix, port, cwd: ROOT }), { createNew: true });
  const drains = ["stdout", "stderr"].map(async name => {
    const file = await Deno.open(`${directory}/server-${name}.log`, { write: true, createNew: true });
    try { for await (const chunk of child[name]) { let offset = 0; while (offset < chunk.length) offset += await file.write(chunk.subarray(offset)); } } finally { file.close(); }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const end = Date.now() + 30000;
  for (;;) {
    try { const response = await fetch(`${baseUrl}${prefix}/_/api/health`, { signal: AbortSignal.timeout(5000) }); await response.body?.cancel(); if (response.ok) break; } catch { /* readiness only */ }
    if (Date.now() >= end) throw Error(`First-run server startup deadline; retained PID ${child.pid}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { baseUrl, pid: child.pid, async close() { child.kill("SIGTERM"); await child.status; await Promise.all(drains); } };
}
async function fixture(label, protectedMode) {
  assert(fixtures.every(item => item.closed), "Previous successful fixture not closed");
  const directory = `${artifacts}/${label}`; await Deno.mkdir(directory);
  const vault = await Deno.makeTempDir({ prefix: `access-native-${label}-vault-` }), state = await Deno.makeTempDir({ prefix: `access-native-${label}-state-` });
  await Deno.writeTextFile(`${vault}/Seed.md`, label === "locked-controls" ? "Seed content.\n\n```text\nfirst code line\nsecond code line\n```\n" : "Seed content.\n");
  const secret = crypto.randomUUID();
  const setup = protectedMode === "setup", totp = protectedMode === "totp", protectedAccount = !setup && !!protectedMode;
  const prefix = label.includes("prefixed") ? "/notes" : "";
  const config = protectedAccount ? { auth_type: totp ? "totp" : "password", ...(totp ? { totp_key: crypto.randomUUID() } : {}), username, password_hash: await hashPassword(password), secret_key: secret, brand_name: "Native retained brand", unrelated_fixture: { kept: true } } : label === "locked-controls" ? { auth_type: "none", brand_name: "Native locked brand", brand_accent: "#aabbcc", unrelated_fixture: { kept: true } } : { auth_type: "none" };
  if (!setup) await Deno.writeTextFile(`${state}/config.json`, JSON.stringify(config));
  if (["public-lock", "peer-policy", "locked-controls"].includes(label)) {
    await Deno.mkdir(`${state}/plugins/access-workflow`, { recursive: true });
    await Deno.writeTextFile(`${state}/plugins/access-workflow/manifest.json`, JSON.stringify({ id: "access-workflow", ...(label === "locked-controls" ? { capabilities: { network: ["127.0.0.1:9", "127.0.0.1:10"], imports: false } } : {}), runtime: { server: "service.js" }, hooks: ["on-save"], settings: [{ id: "preferences", label: "Access workflow settings", renderer: { kind: "declarative-v1", version: 1 }, fields: [{ key: "message", label: "Message", type: "text", default: "default consumer" }, { key: "limit", label: "Limit", type: "number", default: 5, min: 1, max: 10 }] }] }));
    await Deno.writeTextFile(`${state}/plugins/access-workflow/service.js`, `const owner=crypto.randomUUID();export function activate(ctx){ctx.hooks.on('on-save',async fact=>{const data=await ctx.data.load();await ctx.data.save({count:(data.values.count??0)+1,content:fact.after?.content??'',message:(await ctx.settings.read()).values.preferences.message},data.revision);});ctx.commands.register({id:'report',label:'Access workflow report',target:'server'},async()=>({owner,...(await ctx.data.load()).values}));${label === "locked-controls" ? "ctx.commands.register({id:'request',label:'Locked request publication',target:'server'},async()=>{const view=await ctx.permissions.status();return ctx.permissions.requestAccess({kind:'network',hosts:['127.0.0.1:10'],reason:'Native locked request fixture'},{source:view.source});});" : ""}}`);
    await Deno.writeTextFile(`${state}/plugins.json`, JSON.stringify({ enabled: ["access-workflow"], autoEnable: false }));
  }
  const token = protectedAccount ? await new SignJWT({ sub: username }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(secret)) : null;
  let server = setup ? await bootFirstRun(vault, state, directory, prefix) : await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: label === "pinned-credentials" ? "password" : "", GLOBNOTES_AUTO_ENABLE_PLUGINS: label === "locked-controls" ? "" : "false", GLOBNOTES_PATH_PREFIX: prefix, ...(label === "pinned-credentials" ? { GLOBNOTES_USERNAME: username, GLOBNOTES_PASSWORD: password, GLOBNOTES_SECRET_KEY: secret } : {}) }, logsDir: directory, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (label === "peer-policy") server = createSettingsRestartFixture({ initialServer: server, directory, launch: async count => {
    const logsDir = `${directory}/backend-${count}`; await Deno.mkdir(logsDir);
    return bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_AUTO_ENABLE_PLUGINS: "false" }, logsDir });
  } });
  const session = await nativeSession({ port });
  owned = { label, directory, vault, state, server, session, prefix, closed: false, initial: config };
  fixtures.push(owned);
  await Deno.writeTextFile(`${directory}/ownership.json`, JSON.stringify({ label, vault, state, pid: server.pid, baseUrl: server.baseUrl, targetId: session.targetId, browserContextId: session.browserContextId }, null, 2), { createNew: true });
  await session.goto(`${server.baseUrl}${prefix}/Seed`);
  if (setup) { await session.poll("!!document.querySelector('#setup-title')"); return; }
  if (protectedAccount) {
    await session.poll("!!document.querySelector('#username')");
    await fill("#username", username); await fill("#password", password);
    if (totp) { const { totpSecretFromRawKey } = await import("../../../server/auth/local.ts"); await fill("#one-time-code", await authenticatorCode(totpSecretFromRawKey(config.totp_key), Date.now())); }
    await session.button("Log In");
  }
  await session.poll("!!document.querySelector('.toast-viewer')");
}
async function fill(selector, value) {
  const session = owned.session;
  await session.click(selector);
  await session.poll(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); return input && document.activeElement===input && !input.disabled && !input.closest('[inert]'); })()`);
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await session.type(value);
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
}
async function access({ pinnedMode = false } = {}) {
  const session = owned.session;
  if (await session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
  await session.click('[aria-label="Settings"]'); await session.button("Access"); await session.button("Change access mode");
  await session.poll(pinnedMode ? "!!document.querySelector('#setup-title') && !!document.querySelector('#access-current-password') && !document.querySelector('#access-current-password').disabled" : "!!document.querySelector('#setup-title') && !document.querySelector('#setup-mode-none').disabled");
}
async function edit(marker) {
  const session = owned.session;
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
  await session.button("Edit", ".content-column"); await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await session.click(".cm-content"); await session.type(marker + "\n");
  await session.poll(`document.querySelector('.cm-content')?.textContent.includes(${JSON.stringify(marker)})`);
  await session.evaluate("window.__accessEditor=document.querySelector('.cm-content');window.__accessToken=sessionStorage.getItem('token');true");
}
async function api(route, method = "GET", body, token) {
  const response = await fetch(`${owned.server.baseUrl}${owned.prefix}/_/api/${route}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}
const saved = () => Deno.readTextFile(`${owned.state}/config.json`);
async function screenshot(name) {
  const result = await owned.session.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${owned.directory}/${name}.png`, Uint8Array.from(atob(result.data), char => char.charCodeAt(0)));
}
async function finishCase(name, consumers) {
  assert(owned.session.errors.length === 0, "Browser page exception");
  await Deno.writeTextFile(`${owned.directory}/consumers.json`, JSON.stringify({ name, ...consumers, pageErrors: owned.session.errors }, null, 2), { createNew: true });
  await owned.session.close(); await owned.server.close(); owned.closed = true;
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  assert(!targets.some(target => target.id === owned.session.targetId), "Successful target still live");
  let stopped = false;
  try { const response = await fetch(`${owned.server.baseUrl}/_/api/health`, { signal: AbortSignal.timeout(5000) }); await response.body?.cancel(); }
  catch (error) { if (!(error instanceof TypeError)) throw error; stopped = true; }
  assert(stopped, "Successful server still live");
  await Deno.writeTextFile(`${owned.directory}/closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true }), { createNew: true });
  outcomes.push({ name, passed: true }); console.log(`ok: ${name}`);
}
try {
  await fixture("initial-public-prefixed", "setup");
  await owned.session.click("#setup-mode-read_only"); await owned.session.click("#setup-mode-password"); await owned.session.click("#setup-mode-none");
  assert(await owned.session.evaluate("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')==='false'"), "First-run radio exploration incorrectly selected migration locking");
  await screenshot("initial-public-default-off");
  await owned.session.click("#setup-ack"); await owned.session.button("Finish setup"); await owned.session.poll("!document.querySelector('#setup-title')");
  assert((await api("config")).body.settingsWritable === true && JSON.parse(await saved()).read_only_settings === false, "First-run public default did not persist unlocked");
  assert((await api("notes", "POST", { path: "Initial", content: "Initial public consumer\n" })).status === 200, "First-run public note creation denied");
  assert(await Deno.readTextFile(`${owned.vault}/Initial.md`) === "Initial public consumer\n", "Initial public write did not reach disk");
  await finishCase("native prefixed first-run public default and note consumer", { initialDefaultOff: true, prefix: "/notes", publicWritePersisted: true });

  await fixture("totp-in-place", true);
  const session = owned.session;
  await edit("Native enrolment cancellation marker");
  const bytes = await saved(), oldToken = await session.evaluate("sessionStorage.getItem('token')");
  await access(); await session.click("#setup-totp");
  await session.poll("!!document.querySelector('#setup-totp-qr img')");
  assert(await saved() === bytes, "Opening enrolment changed configuration");
  assert((await api("auth-check", "GET", undefined, oldToken)).status === 200, "Opening enrolment invalidated the session");
  await session.click('[aria-label="Dismiss setup"]'); await session.poll("!document.querySelector('#setup-title')");
  assert(await session.evaluate("document.querySelector('.cm-content') === window.__accessEditor && document.querySelector('.cm-content').textContent.includes('Native enrolment cancellation marker')"), "Cancelled enrolment lost the dirty editor");
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
  await session.button("Save", ".content-column");
  await session.poll("(() => { const button=[...document.querySelectorAll('.content-column button')].find(item=>item.textContent.trim()==='Save'); return button?.getAttribute('aria-busy')==='false' && !button.querySelector('.animate-spin'); })()");
  // Await the actual persisted consumer before starting a clean Access attempt.
  await session.poll("fetch('/_/api/notes/Seed',{headers:{authorization:'Bearer '+sessionStorage.getItem('token')}}).then(r=>r.json()).then(n=>n.content.includes('Native enrolment cancellation marker'))");
  const bundles = [];
  const dispose = session.page.onEvent(event => { if (event.method === "Network.responseReceived" && event.params.response.url.endsWith("/_/api/access/totp-enrolment")) bundles.push(event.params.requestId); });
  await access(); await session.click("#setup-totp"); await session.poll("!!document.querySelector('#setup-totp-qr img')");
  assert(bundles.length === 1, "Expected one configured enrolment response");
  const response = await session.send("Network.getResponseBody", { requestId: bundles[0] });
  const bundle = JSON.parse(response.base64Encoded ? atob(response.body) : response.body);
  await fill("#access-current-password", password);
  await fill("#setup-totp-code", await authenticatorCode(bundle.secret, Date.now() - 300_000));
  await session.button("Save access settings");
  await session.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('Confirm the new authenticator')");
  assert(await saved() === bytes, "Invalid new code changed config");
  assert((await api("auth-check", "GET", undefined, oldToken)).status === 200, "Invalid enrolment logged the user out");
  const confirmedCode = await authenticatorCode(bundle.secret, Date.now());
  await fill("#setup-totp-code", confirmedCode);
  await session.button("Save access settings");
  await session.poll("!!document.querySelector('#username') && !document.querySelector('#setup-title')");
  const after = JSON.parse(await saved());
  assert(after.auth_type === "totp" && after.password_hash === owned.initial.password_hash && after.username === username && after.brand_name === owned.initial.brand_name && after.unrelated_fixture.kept, "Confirmed 2FA replaced existing credentials/config");
  assert((await api("auth-check", "GET", undefined, oldToken)).status === 401, "Confirmed 2FA left old session valid");
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
  const now = Date.now(), loginCodes = await Promise.all([now, now - 30_000, now + 30_000].map(time => authenticatorCode(bundle.secret, time)));
  await fill("#username", username); await fill("#password", password); await fill("#one-time-code", loginCodes.find(code => code !== confirmedCode));
  await session.button("Log In"); await session.poll("!document.querySelector('#username')");
  const freshToken = await session.evaluate("sessionStorage.getItem('token')");
  assert((await api("auth-check", "GET", undefined, freshToken)).status === 200, "Confirmed authenticator cannot sign in");
  dispose();
  await finishCase("native enrolment cancellation/invalid-code/confirmed-login consumer", { originalHashRetained: true, unrelatedConfigRetained: true, invalidCodeRetainedSession: true, oldSessionRevokedAfterConfirmation: true, confirmedLoginAccepted: true });

  await fixture("public-lock", false);
  const seeded = await api("plugin-host/access-workflow/settings/preferences", "PUT", { values: { message: "retained settings consumer" }, revision: 0 });
  assert(seeded.status === 200, "Public unlocked settings seed rejected");
  const workflowOwner = (await api("plugin-host/access-workflow/commands/report", "POST", {})).body.result.owner;
  await edit("Native public settings-lock saved marker");
  await access();
  assert(await owned.session.evaluate("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')==='false'"), "Existing public lock default differs from saved value");
  await owned.session.click("#setup-read-only-settings"); await owned.session.click("#setup-ack"); await screenshot("public-settings-lock");
  await owned.session.button("Save access settings"); await owned.session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')");
  await owned.session.button("Save", '[data-modal-top="true"]'); await owned.session.poll("!document.querySelector('#setup-title')");
  assert(await owned.session.evaluate("document.querySelector('.cm-content')===window.__accessEditor"), "Settings-only lock replaced the editor");
  assert((await api("config")).body.settingsWritable === false, "Public settings did not lock");
  assert((await Deno.readTextFile(`${owned.vault}/Seed.md`)).includes("Native public settings-lock saved marker"), "Handoff Save did not reach disk");
  if (await owned.session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await owned.session.click('[title="Close sidebar"]');
  await owned.session.click(".cm-content"); await owned.session.type("Still public after settings lock\n"); await owned.session.button("Save", ".content-column");
  await owned.session.poll("fetch('/_/api/notes/Seed').then(r=>r.json()).then(n=>n.content.includes('Still public after settings lock'))");
  assert((await Deno.readTextFile(`${owned.vault}/Seed.md`)).includes("Still public after settings lock"), "Locked settings prevented actual public note save");
  await owned.session.poll("fetch('/_/api/plugin-host/access-workflow/commands/report',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(report=>report.result.content.includes('Still public after settings lock') && report.result.message==='retained settings consumer')");
  assert((await api("plugin-host/access-workflow/commands/report", "POST", {})).body.result.owner === workflowOwner, "Settings-only lock replaced the unrelated workflow owner");
  assert(JSON.parse(await Deno.readTextFile(`${owned.state}/plugin-data/access-workflow/data.json`)).values.content.includes("Still public after settings lock"), "Unrelated private workflow data did not persist under settings lock");
  for (const [route, method] of [["brand", "POST"], ["plugin-host/policy", "PUT"], ["plugin-host/missing/enabled", "PUT"], ["plugin-host/missing/settings/page", "PUT"], ["plugin-host/missing/permissions", "PUT"], ["plugin-host/missing/permission-requests/request/decision", "POST"], ["access", "PUT"], ["access/totp-enrolment", "POST"], ["setup/reset", "POST"]]) assert((await api(route, method, {})).status === 403, `Locked public mutation escaped: ${route}`);
  if (await owned.session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await owned.session.click('[title="Open sidebar"]');
  await owned.session.click('[aria-label="Settings"]'); await owned.session.button("Access");
  assert(!await owned.session.evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Change access mode')"), "Locked Access can unlock itself");
  await owned.session.button("Appearance"); await owned.session.click('[data-theme-id="globnotes-light"]');
  await owned.session.poll("localStorage.getItem('globnotes-theme')==='globnotes-light' && !document.body.classList.contains('dark')");
  await finishCase("native public lock keeps note editing and local preferences while denying controls", { publicNoteSavePersisted: true, sameEditor: true, settingsApisDenied: 9, accessUnlockUnavailable: true, localThemeAvailable: true, sameWorkflowOwner: true, privateWorkflowConsumerPersisted: true });

  for (const decision of ["Cancel", "Save"]) {
    await fixture(`protected-public-${decision.toLowerCase()}`, true);
    await edit(`Native migration ${decision} marker`);
    const before = await saved(), token = await owned.session.evaluate("sessionStorage.getItem('token')");
    await access(); await owned.session.click("#setup-mode-none");
    assert(await owned.session.evaluate("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')==='true'"), "Protected migration did not default settings locking on");
    await fill("#access-current-password", password); await owned.session.click("#setup-ack");
    await owned.session.button("Save access settings"); await owned.session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')");
    await owned.session.button(decision, '[data-modal-top="true"]');
    if (decision === "Cancel") {
      await owned.session.poll("!!document.querySelector('#setup-title') && !document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')");
      assert(await saved() === before && (await api("auth-check", "GET", undefined, token)).status === 200, "Cancel changed access/session");
      assert(await owned.session.evaluate("document.querySelector('.cm-content')===window.__accessEditor && document.querySelector('.cm-content').textContent.includes('Native migration Cancel marker')"), "Cancel lost editor/buffer");
    } else {
      await owned.session.poll("!document.querySelector('#setup-title')");
      assert((await api("config")).body.settingsWritable === false, "Migration failed to persist settings lock");
      assert((await Deno.readTextFile(`${owned.vault}/Seed.md`)).includes("Native migration Save marker"), "Migration Save not persisted");
      assert((await api("token", "POST", { username, password })).status === 404, "Public mode retained management login");
    }
    await finishCase(`native protected-to-public ${decision.toLowerCase()} handoff`, { migrationDefaultOn: true, decision, noteAndPolicyConsumers: true });
  }

  await fixture("current-totp-password", "totp");
  const { totpSecretFromRawKey } = await import("../../../server/auth/local.ts");
  const currentSecret = totpSecretFromRawKey(owned.initial.totp_key);
  const old = await owned.session.evaluate("sessionStorage.getItem('token')"), original = await saved();
  await access(); await fill("#setup-password", "changed-native-password"); await fill("#access-current-password", password);
  await fill("#access-current-totp", await authenticatorCode(currentSecret, Date.now() - 300_000));
  await owned.session.button("Save access settings");
  await owned.session.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('confirmation failed')");
  assert(await saved() === original && (await api("auth-check", "GET", undefined, old)).status === 200, "Wrong current TOTP changed credentials/session");
  const acceptedCode = await authenticatorCode(currentSecret, Date.now() + 30_000);
  await fill("#access-current-totp", acceptedCode); await owned.session.button("Save access settings"); await owned.session.poll("!!document.querySelector('#username') && !document.querySelector('#setup-title')");
  assert((await api("auth-check", "GET", undefined, old)).status === 401, "Password change did not invalidate the old session");
  assert(JSON.parse(await saved()).totp_key === owned.initial.totp_key, "Password change replaced the existing authenticator");
  if (await owned.session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await owned.session.click('[title="Close sidebar"]');
  const codeNow = Date.now(), currentCodes = await Promise.all([codeNow, codeNow - 30_000, codeNow + 30_000].map(time => authenticatorCode(currentSecret, time)));
  await fill("#username", username); await fill("#password", "changed-native-password"); await fill("#one-time-code", currentCodes.find(code => code !== acceptedCode));
  await owned.session.button("Log In"); await owned.session.poll("!document.querySelector('#username')");
  assert((await api("auth-check", "GET", undefined, await owned.session.evaluate("sessionStorage.getItem('token')"))).status === 200, "Changed password/current authenticator cannot log in");
  await finishCase("native fresh-current-2FA rejection and password-change login", { wrongCurrentCodePreservedSession: true, passwordChangeRevokedOldSession: true, currentAuthenticatorRetained: true, newPasswordLoginAccepted: true });

  await fixture("lost-password-receipt", true);
  await access(); await fill("#setup-password", "recovered-native-password"); await fill("#access-current-password", password);
  let paused = null, writes = 0;
  const stop = owned.session.page.onEvent(event => {
    if (event.method === "Fetch.requestPaused" && event.params.request.url.endsWith("/_/api/access") && event.params.request.method === "PUT") { paused = event.params; writes++; }
  });
  await owned.session.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/access", requestStage: "Response" }] });
  await owned.session.button("Save access settings");
  await owned.session.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('outcome is unknown')");
  assert(paused && JSON.parse(await saved()).access_revision === 1, "Response gate did not observe a persisted password change");
  assert(await owned.session.evaluate("document.querySelector('[aria-labelledby=setup-title] button[type=submit]').disabled"), "Unresolved Access wire permits duplicate writes");
  await owned.session.click('[aria-label="Dismiss setup"]');
  assert(await owned.session.evaluate("!!document.querySelector('#setup-title')"), "Unresolved Access write was dismissed");
  await owned.session.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "Failed" });
  await owned.session.send("Fetch.disable");
  await owned.session.poll("[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Review current access' && !button.disabled)");
  await owned.session.button("Review current access"); await owned.session.poll("!!document.querySelector('#username') && !document.querySelector('#setup-title')");
  assert(writes === 1, "Lost access receipt was replayed");
  if (await owned.session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await owned.session.click('[title="Close sidebar"]');
  await fill("#username", username); await fill("#password", "recovered-native-password"); await owned.session.button("Log In"); await owned.session.poll("!document.querySelector('#username')");
  assert((await api("auth-check", "GET", undefined, await owned.session.evaluate("sessionStorage.getItem('token')"))).status === 200, "Recovered password cannot sign in");
  stop(); await finishCase("native lost-password-receipt durable read-back without replay", { actualPersistedRevision: 1, unresolvedDismissalBlocked: true, writes: 1, explicitReadBackRecovered: true, intendedPasswordLoginAccepted: true });

  await fixture("replace-authenticator", "totp");
  const replacementToken = await owned.session.evaluate("sessionStorage.getItem('token')"), replacementBefore = await saved();
  const originalSecret = totpSecretFromRawKey(owned.initial.totp_key), replacementRequests = [];
  const disposeReplacement = owned.session.page.onEvent(event => { if (event.method === "Network.responseReceived" && event.params.response.url.endsWith("/_/api/access/totp-enrolment")) replacementRequests.push(event.params.requestId); });
  await access(); await owned.session.button("Set up a new authenticator"); await owned.session.poll("!!document.querySelector('#setup-totp-qr img')");
  const replacementResponse = await owned.session.send("Network.getResponseBody", { requestId: replacementRequests[0] });
  const replacement = JSON.parse(replacementResponse.base64Encoded ? atob(replacementResponse.body) : replacementResponse.body);
  assert(await saved() === replacementBefore && (await api("auth-check", "GET", undefined, replacementToken)).status === 200, "Opening replacement changed the existing account/session");
  await fill("#access-current-password", password); await fill("#access-current-totp", await authenticatorCode(originalSecret, Date.now() + 30_000));
  const newConfirmation = await authenticatorCode(replacement.secret, Date.now()); await fill("#setup-totp-code", newConfirmation);
  await owned.session.button("Save access settings"); await owned.session.poll("!!document.querySelector('#username') && !document.querySelector('#setup-title')");
  const replacementSaved = JSON.parse(await saved());
  assert(replacementSaved.totp_key === replacement.key && replacementSaved.password_hash === owned.initial.password_hash, "Authenticator replacement changed the password or failed to persist the new key");
  assert((await api("auth-check", "GET", undefined, replacementToken)).status === 401, "Confirmed replacement retained old session authority");
  assert((await api("token", "POST", { username, password: password + newConfirmation })).status === 401, "Replacement enrolment code can be replayed as login");
  if (await owned.session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await owned.session.click('[title="Close sidebar"]');
  const replacementNow = Date.now(), replacementCodes = await Promise.all([replacementNow, replacementNow - 30_000, replacementNow + 30_000].map(time => authenticatorCode(replacement.secret, time)));
  await fill("#username", username); await fill("#password", password); await fill("#one-time-code", replacementCodes.find(code => code !== newConfirmation));
  await owned.session.button("Log In"); await owned.session.poll("!document.querySelector('#username')");
  disposeReplacement(); await finishCase("native current/new authenticator proofs and replacement login", { activeKeyUnchangedDuringEnrolment: true, passwordHashRetained: true, confirmedNewKeyPersisted: true, spentNewCodeRejected: true, replacementLoginAccepted: true });

  await fixture("peer-policy", false);
  const peer = await nativeSession({ port }); owned.peer = peer;
  await Deno.writeTextFile(`${owned.directory}/peer-ownership.json`, JSON.stringify({ targetId: peer.targetId, browserContextId: peer.browserContextId, serverPid: owned.server.pid, baseUrl: owned.server.baseUrl }), { createNew: true });
  await peer.goto(`${owned.server.baseUrl}/Seed`); await peer.poll("!!document.querySelector('.toast-viewer')");
  await peer.button("Edit", ".content-column"); await peer.button("Source", ".content-column"); await peer.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await peer.click(".cm-content"); await peer.type("Peer retained dirty note marker\n");
  await peer.evaluate("window.__peerEditor=document.querySelector('.cm-content');true");
  await peer.click('[title="Open sidebar"]'); await peer.click('[aria-label="Settings"]'); await peer.button("Access workflow settings");
  await peer.poll("!!document.querySelector('#settings-field-limit') && !document.querySelector('#settings-field-limit').readOnly");
  await peer.click("#settings-field-limit"); await peer.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 }); await peer.key("Backspace", { windowsVirtualKeyCode: 8 });
  await peer.poll("document.querySelector('#settings-field-limit').value === ''");
  await access(); await owned.session.click("#setup-read-only-settings"); await owned.session.click("#setup-ack"); await owned.session.button("Save access settings"); await owned.session.poll("!document.querySelector('#setup-title')");
  await peer.poll("document.querySelector('#settings-field-limit')?.readOnly || document.querySelector('#settings-field-limit')?.disabled");
  assert(await peer.evaluate("document.querySelector('#settings-field-limit').value === '' && document.querySelector('.cm-content')===window.__peerEditor && document.querySelector('.cm-content').textContent.includes('Peer retained dirty note marker')"), "Remote lock discarded the peer's invalid setting or dirty editor");
  assert((await api("plugin-host/access-workflow/settings/preferences", "PUT", { values: { message: "blocked peer", limit: 5 }, revision: 0 })).status === 403, "Peer can mutate settings after remote lock");
  const preRestartOwner = (await api("plugin-host/access-workflow/commands/report", "POST", {})).body.result.owner;
  const restart = await owned.server.restart();
  assert(restart.oldPid !== restart.newPid, "Owned backend did not restart");
  assert((await api("config")).body.settingsWritable === false, "Restart lost the public settings lock");
  await peer.poll(`fetch('/_/api/plugin-host/access-workflow/commands/report',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(report=>report.result.owner!==${JSON.stringify(preRestartOwner)})`);
  assert(await peer.evaluate("fetch('/_/api/config').then(r=>r.json()).then(config=>config.settingsWritable===false && config.readOnlySettings===true)"), "Peer did not observe persisted policy from the restarted backend");
  await peer.poll("document.querySelector('#settings-field-limit')?.readOnly || document.querySelector('#settings-field-limit')?.disabled");
  assert(await peer.evaluate("document.querySelector('#settings-field-limit').value === '' && document.querySelector('.cm-content')===window.__peerEditor"), "Restart reconciliation replaced peer drafts/editor");
  assert((await api("notes", "POST", { path: "AfterRestart", content: "Public after restart\n" })).status === 200 && await Deno.readTextFile(`${owned.vault}/AfterRestart.md`) === "Public after restart\n", "Restart/settings lock blocked public note writes");
  assert(peer.errors.length === 0, "Peer page exception");
  await peer.close();
  await finishCase("native independent peer and restart settings-policy/draft consumers", { independentContexts: true, peerInvalidDraftRetained: true, samePeerEditor: true, settingsApisDenied: true, restartLockPersisted: true, publicWriteAfterRestartPersisted: true });

  await fixture("initial-public-explicit-lock-prefixed", "setup");
  await owned.session.click("#setup-mode-none");
  assert(await owned.session.evaluate("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')==='false'"), "Explicit first-run choice did not start unlocked");
  await owned.session.click("#setup-read-only-settings"); await owned.session.click("#setup-ack");
  await owned.session.button("Finish setup"); await owned.session.poll("!document.querySelector('#setup-title')");
  assert(JSON.parse(await saved()).read_only_settings === true && (await api("config")).body.settingsWritable === false, "Explicit first-run lock was not persisted/effective");
  assert((await api("access", "PUT", {})).status === 403, "Explicit first-run lock permits self-unlock");
  assert((await api("notes", "POST", { path: "ExplicitLocked", content: "Explicit initial lock public note consumer\n" })).status === 200, "Explicit initial lock denied public note creation");
  assert(await Deno.readTextFile(`${owned.vault}/ExplicitLocked.md`) === "Explicit initial lock public note consumer\n", "Explicit initial lock note did not reach disk");
  await finishCase("native explicit first-run locking still permits prefixed public note writes", { explicitInitialLockPersisted: true, prefix: "/notes", selfUnlockDenied: true, publicNoteConsumerPersisted: true });

  await fixture("protected-public-explicit-unlocked", true);
  await access(); await owned.session.click("#setup-mode-none");
  assert(await owned.session.evaluate("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')==='true'"), "Explicit migration did not start from locked default");
  await owned.session.click("#setup-read-only-settings");
  await owned.session.click("#setup-mode-read_only"); await owned.session.click("#setup-mode-none");
  assert(await owned.session.evaluate("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')==='false'"), "Radio exploration erased the explicit migration choice");
  await fill("#access-current-password", password); await owned.session.click("#setup-ack"); await owned.session.button("Save access settings");
  await owned.session.poll("!document.querySelector('#setup-title')");
  const explicitlyOpen = JSON.parse(await saved());
  assert(explicitlyOpen.read_only_settings === false && explicitlyOpen.unrelated_fixture.kept && (await api("config")).body.settingsWritable === true, "Explicit unlocked migration did not preserve/effectively persist its choice");
  assert((await api("token", "POST", { username, password })).status === 404, "Unlocked public migration invented management login");
  const unlockedCatalog = (await api("plugin-host")).body, selectedPlugin = unlockedCatalog.plugins[0].id;
  assert((await api(`plugin-host/${selectedPlugin}/enabled`, "PUT", { enabled: false, revision: unlockedCatalog.policy.revision, signature: unlockedCatalog.policy.signature })).status === 200, "Explicit unlocked migration denied an actual settings mutation");
  assert(JSON.parse(await Deno.readTextFile(`${owned.state}/plugins.json`)).disabled.includes(selectedPlugin), "Explicit unlocked settings write did not reach policy disk");
  assert((await api("notes", "POST", { path: "ExplicitOpen", content: "Explicit migration public note consumer\n" })).status === 200 && await Deno.readTextFile(`${owned.vault}/ExplicitOpen.md`) === "Explicit migration public note consumer\n", "Explicit unlocked migration did not retain actual public note writes");
  await finishCase("native explicit migration unlock survives radios and reaches settings/note consumers", { migrationChoiceRetained: true, explicitUnlockedPolicyPersisted: true, unrelatedConfigRetained: true, realSettingsMutationPersisted: true, publicNoteConsumerPersisted: true, managementLoginAbsent: true });

  const exerciseProtectedGeometry = async kind => {
  const currentAuthenticator = kind === "totp";
  await fixture(currentAuthenticator ? "protected-current-totp-geometry" : "protected-enrolment-geometry", kind);
  await edit("Protected geometry retained editor marker");
  const geometryBytes = await saved(), geometryToken = await owned.session.evaluate("sessionStorage.getItem('token')");
  const geometryFrames = [];
  for (const viewport of [{ name: "wide", width: 1280, height: 900 }, { name: "narrow", width: 360, height: 640 }]) {
    for (const dpr of [1, 2]) for (const theme of ["light", "dark"]) {
      const label = `${viewport.name}-dpr-${dpr}-${theme}`;
      await owned.session.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: dpr, mobile: false });
      if (await owned.session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await owned.session.click('[title="Open sidebar"]');
      await owned.session.click('[aria-label="Settings"]'); await owned.session.button("Appearance");
      await owned.session.click(`[data-theme-id="globnotes-${theme}"]`);
      await owned.session.poll(`document.body.classList.contains('dark')===${theme === "dark"}`);
      await owned.session.click('[aria-label="Close settings"]'); await owned.session.poll("!document.querySelector('#settings-modal-title')");
      await access();
      if (currentAuthenticator) await owned.session.button("Set up a new authenticator");
      else await owned.session.click("#setup-totp");
      await owned.session.poll("document.querySelector('#setup-totp-qr img')?.naturalWidth>0");
      await owned.session.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
      const geometry = await owned.session.evaluate(`(()=>{
        const box=document.querySelector('[data-modal-top=true] [aria-labelledby=setup-title]'),r=box.getBoundingClientRect(),form=box.querySelector('form');
        const body=form.firstElementChild.getBoundingClientRect(),enrolment=box.querySelector('.setup-totp-enrolment').getBoundingClientRect(),confirmation=box.querySelector('form>fieldset').getBoundingClientRect();
        const visible=[...box.querySelectorAll('input,button,label[for]')].filter(el=>!el.closest('[inert],[aria-hidden=true]')&&getComputedStyle(el).visibility==='visible'&&el.getBoundingClientRect().width>0);
        return {rect:r.toJSON(),body:body.toJSON(),enrolment:enrolment.toJSON(),confirmation:confirmation.toJSON(),scrollWidth:box.scrollWidth,clientWidth:box.clientWidth,scrollHeight:box.scrollHeight,clientHeight:box.clientHeight,contained:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
          controls:visible.map(el=>({id:el.id||el.getAttribute('for')||el.getAttribute('aria-label')||el.textContent.trim(),rect:el.getBoundingClientRect().toJSON()})),sameEditor:document.querySelector('.cm-content')===window.__accessEditor,shellInert:document.querySelector('[data-app-shell]').inert};
      })()`);
      await screenshot(`protected-${label}`);
      await Deno.writeTextFile(`${owned.directory}/protected-${label}.json`, JSON.stringify({ label, viewport, dpr, theme, ...geometry, screenshot: `protected-${label}.png` }, null, 2), { createNew: true });
      assert(geometry.contained && geometry.scrollWidth - geometry.clientWidth <= 1, `${label}: protected enrolment dialog horizontal containment failed`);
      assert(geometry.body.bottom >= geometry.enrolment.bottom - 0.5 && geometry.confirmation.top >= geometry.enrolment.bottom - 0.5, `${label}: current proof/action overlap the intrinsic enrolment body`);
      assert(geometry.controls.every(control => control.rect.x >= geometry.rect.x - 0.5 && control.rect.right <= geometry.rect.right + 0.5), `${label}: protected enrolment control escaped horizontally`);
      assert(geometry.sameEditor && geometry.shellInert, `${label}: protected geometry lost editor/inertness`);
      await owned.session.click("#setup-totp-qr");
      await owned.session.poll("document.querySelector('#setup-totp-copy-feedback')?.textContent==='Click again to copy the setup key.'");
      const copyConfirmation = await owned.session.evaluate("(()=>{const box=document.querySelector('[data-modal-top=true] [aria-labelledby=setup-title]'),tooltip=box.querySelector('#setup-totp-copy-feedback'),qr=box.querySelector('#setup-totp-qr');return {dialog:box.getBoundingClientRect().toJSON(),qr:qr.getBoundingClientRect().toJSON(),feedback:tooltip.getBoundingClientRect().toJSON(),scrollWidth:box.scrollWidth,clientWidth:box.clientWidth};})()");
      await screenshot(`protected-${label}-copy-confirmation`);
      await Deno.writeTextFile(`${owned.directory}/protected-${label}-copy-confirmation.json`, JSON.stringify(copyConfirmation, null, 2), { createNew: true });
      assert(copyConfirmation.scrollWidth - copyConfirmation.clientWidth <= 1 && copyConfirmation.feedback.x >= copyConfirmation.dialog.x - 0.5 && copyConfirmation.feedback.right <= copyConfirmation.dialog.right + 0.5, `${label}: authenticator copy confirmation escaped horizontally`);
      assert(copyConfirmation.feedback.y >= copyConfirmation.qr.bottom - 0.5 && copyConfirmation.feedback.y >= copyConfirmation.dialog.y - 0.5 && copyConfirmation.feedback.bottom <= copyConfirmation.dialog.bottom + 0.5, `${label}: authenticator copy confirmation overlaps QR or is not visible within its dialog`);
      await owned.session.click("#access-current-password");
      await owned.session.poll("document.activeElement===document.querySelector('#access-current-password')");
      await owned.session.poll("!document.querySelector('#setup-totp-copy-feedback')");
      const focused = await owned.session.evaluate("(()=>{const el=document.querySelector('#access-current-password'),r=el.getBoundingClientRect();return {rect:r.toJSON(),hit:el===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),insideDialog:el.closest('[role=dialog]').contains(document.activeElement)};})()");
      assert(focused.hit && focused.insideDialog, `${label}: native current-password focus is not reachable`);
      await screenshot(`protected-${label}-current-proof`);
      await Deno.writeTextFile(`${owned.directory}/protected-${label}-current-proof.json`, JSON.stringify(focused, null, 2), { createNew: true });
      if (currentAuthenticator) {
        assert(await owned.session.evaluate("document.querySelector('label[for=setup-totp-code]').textContent.trim()==='Code from the new authenticator' && document.querySelector('label[for=access-current-totp]').textContent.trim()==='Code from the current authenticator'"), `${label}: current/new authenticator proof labels are not distinct`);
        await owned.session.click("#access-current-totp"); await owned.session.poll("document.activeElement===document.querySelector('#access-current-totp')");
        const currentProof = await owned.session.evaluate("(()=>{const el=document.querySelector('#access-current-totp'),r=el.getBoundingClientRect();return {rect:r.toJSON(),hit:el===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),insideDialog:el.closest('[role=dialog]').contains(document.activeElement)};})()");
        await screenshot(`protected-${label}-current-authenticator-proof`);
        await Deno.writeTextFile(`${owned.directory}/protected-${label}-current-authenticator-proof.json`, JSON.stringify(currentProof, null, 2), { createNew: true });
        assert(currentProof.hit && currentProof.insideDialog, `${label}: native current-authenticator focus is not reachable`);
      }
      await owned.session.click('[aria-label="Dismiss setup"]'); await owned.session.poll("!document.querySelector('#setup-title')");
      assert(await saved() === geometryBytes && (await api("auth-check", "GET", undefined, geometryToken)).status === 200, `${label}: geometry/enrolment dismissal changed config/session`);
      assert(await owned.session.evaluate("document.querySelector('.cm-content')===window.__accessEditor && document.querySelector('.cm-content').textContent.includes('Protected geometry retained editor marker')"), `${label}: geometry dismissal discarded editor/buffer`);
      geometryFrames.push({ label, contained: true, nativeCurrentProofReachable: true, configurationUnchanged: true, sameEditor: true });
    }
  }
  await finishCase(currentAuthenticator ? "native current/new authenticator replacement viewport/DPR/theme proof geometry" : "native protected enrolment viewport/DPR/theme and current-proof geometry", { geometryFrames, currentAuthenticator, originalConfigRetained: true, originalSessionRetained: true, sameEditor: true });
  };
  await exerciseProtectedGeometry(true);
  await exerciseProtectedGeometry("totp");
  await fixture("locked-controls", false);
  const lockedControls = await exerciseLockedControls({ session: owned.session, api, baseUrl: owned.server.baseUrl, state: owned.state, vault: owned.vault, openAccess: access, capture: screenshot });
  await finishCase("native locked real settings controls and local preferences with public hook consumers", lockedControls);
  await fixture("pinned-credentials", true);
  await edit("Pinned confirmation retained editor marker");
  await owned.session.button("Save", ".content-column");
  await owned.session.poll("(()=>{const button=[...document.querySelectorAll('.content-column button')].find(button=>button.textContent.trim()==='Save');return button?.getAttribute('aria-busy')==='false'&&!button.querySelector('.animate-spin');})()");
  const pinnedToken = await owned.session.evaluate("sessionStorage.getItem('token')"), pinnedBytes = await saved();
  assert((await api("notes/Seed", "GET", undefined, pinnedToken)).body.content.includes("Pinned confirmation retained editor marker"), "Pinned note precondition did not persist before Access");
  if (await owned.session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await owned.session.click('[title="Open sidebar"]');
  await owned.session.click('[aria-label="Settings"]'); await owned.session.button("Appearance"); await owned.session.click('[data-theme-id="globnotes-light"]');
  await owned.session.poll("!document.body.classList.contains('dark')"); await owned.session.click('[aria-label="Close settings"]'); await owned.session.poll("!document.querySelector('#settings-modal-title')");
  await access({ pinnedMode: true });
  assert(await owned.session.evaluate("document.querySelectorAll('input[name=access-mode]').length===3 && [...document.querySelectorAll('input[name=access-mode]')].every(input=>input.disabled) && ['setup-username','setup-password','setup-totp'].every(id=>document.getElementById(id).disabled)"), "Pinned Access mutation fields remain available");
  await fill("#access-current-password", "wrong-current-proof"); await owned.session.button("Save access settings");
  await owned.session.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('confirmation failed')");
  await screenshot("pinned-current-proof-error-wide-light");
  assert(await saved() === pinnedBytes && (await api("auth-check", "GET", undefined, pinnedToken)).status === 200, "Wrong pinned confirmation changed config or session");
  const pinnedView = (await api("access", "GET", undefined, pinnedToken)).body;
  assert(pinnedView.pinned.mode && pinnedView.pinned.username && pinnedView.pinned.password && pinnedView.pinned.sessions, "Effective pin projection missing");
  assert((await api("access", "PUT", { mode: "password", password: "ineffective-pinned-override", currentPassword: password, revision: pinnedView.revision, signature: pinnedView.signature }, pinnedToken)).status === 409, "Direct pinned override pretended to succeed");
  await owned.session.click('[aria-label="Dismiss setup"]'); await owned.session.poll("!document.querySelector('#setup-title')");
  await owned.session.click('[aria-label="Settings"]'); await owned.session.button("Appearance"); await owned.session.click('[data-theme-id="globnotes-dark"]');
  await owned.session.poll("document.body.classList.contains('dark')"); await owned.session.click('[aria-label="Close settings"]'); await owned.session.poll("!document.querySelector('#settings-modal-title')");
  await owned.session.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: false });
  await access({ pinnedMode: true }); await fill("#access-current-password", "wrong-current-proof"); await owned.session.button("Save access settings");
  await owned.session.poll("document.querySelector('[aria-labelledby=setup-title] [role=alert]')?.textContent.includes('confirmation failed')");
  const pinnedGeometry = await owned.session.evaluate("(()=>{const box=document.querySelector('[aria-labelledby=setup-title]'),r=box.getBoundingClientRect(),alert=box.querySelector('[role=alert]').getBoundingClientRect();return {rect:r.toJSON(),alert:alert.toJSON(),scrollWidth:box.scrollWidth,clientWidth:box.clientWidth,contained:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};})()");
  await screenshot("pinned-current-proof-error-narrow-dpr-2-dark");
  await Deno.writeTextFile(`${owned.directory}/pinned-error-geometry.json`, JSON.stringify(pinnedGeometry, null, 2), { createNew: true });
  assert(pinnedGeometry.contained && pinnedGeometry.scrollWidth - pinnedGeometry.clientWidth <= 1 && pinnedGeometry.alert.x >= pinnedGeometry.rect.x - 0.5 && pinnedGeometry.alert.right <= pinnedGeometry.rect.right + 0.5, "Pinned error feedback escaped horizontally");
  assert(await owned.session.evaluate("document.querySelector('.cm-content')===window.__accessEditor && document.querySelector('.cm-content').textContent.includes('Pinned confirmation retained editor marker')"), "Pinned error discarded the retained editor");
  assert(await saved() === pinnedBytes && (await api("auth-check", "GET", undefined, pinnedToken)).status === 200, "Pinned error/override changed account authority");
  await finishCase("native pinned Access controls and real fresh-proof errors retain account/editor authority", { effectiveFieldsPinned: true, invalidCurrentProofRetainedConfigAndSession: true, directPinnedOverrideRejected: true, sameEditor: true, pinnedErrorGeometry: pinnedGeometry });
  console.log("ACCESS NATIVE CHECKPOINT OK (remaining access matrix still required)");
} catch (error) { failure = error; console.error(`FAIL: ${error.stack ?? error}`); }
finally {
  await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({ outcomes, failure: failure?.message, ownership: owned && { vault: owned.vault, state: owned.state, pid: owned.server.pid, baseUrl: owned.server.baseUrl, targetId: owned.session.targetId, browserContextId: owned.session.browserContextId, peerTargetId: owned.peer?.targetId, peerContextId: owned.peer?.browserContextId }, pageErrors: owned?.session.errors }, null, 2));
  if (failure && owned && !owned.closed) {
    await screenshot("failure").catch(error => console.error(error.message));
    await owned.peer?.close(); await owned.session.close(); await owned.server.close(); owned.closed = true;
    await Deno.writeTextFile(`${owned.directory}/failed-fixture-closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true, failureCapturedBeforeClosure: true, filesRetained: true }), { createNew: true });
  }
}
if (failure) throw failure;
