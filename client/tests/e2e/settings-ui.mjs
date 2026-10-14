// Corrective native UI probes; expanded at each documented checkpoint.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { hashPassword } from "../../../server/helpers.ts";
import { SignJWT } from "jose";
import { exerciseInlineSettings } from "./settings-inline-native.mjs";
import { exerciseSettingsGeometry } from "./settings-geometry-native.mjs";
import { exerciseSettingsCrossBrowser } from "./settings-cross-browser-native.mjs";
import { createSettingsRestartFixture } from "./settings-restart-fixture.mjs";
import { exerciseSettingsPending } from "./settings-pending-native.mjs";
import { exerciseSettingsMenu } from "./settings-menu-native.mjs";
import { exerciseSettingsEditor } from "./settings-editor-native.mjs";

let options;
try { options = parseArguments(Deno.args); }
catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) {
  console.log("Usage: settings-ui.mjs [--artifacts <directory>] [--help]");
  Deno.exit(0);
}
const artifacts = options.artifacts ?? await Deno.makeTempDir({ prefix: "settings-ui-artifacts-" });
if (options.artifacts) await Deno.mkdir(artifacts, { mode: 0o700 });
let vault, state;
let server, session, failure;
const outcomes = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const fixtures = [];
const username = "session-fixture";
const password = "fixture-old-secret";
async function fixture(kind, label) {
  assert(fixtures.every(owned => owned.closed), "Previous successful fixture still owns live resources");
  vault = await Deno.makeTempDir({ prefix: `settings-ui-${label}-vault-` });
  state = await Deno.makeTempDir({ prefix: `settings-ui-${label}-state-` });
  await Deno.writeTextFile(`${vault}/NoteA.md`, label === "menu-parity" ? "Seed content.\n\n```text\nfirst code line\nsecond code line\n```\n" : label.startsWith("editor-") ? "---\nstatus: seed\ntags: [native]\n---\n\nSeed editor content.\n" : "Seed content.\n");
  const secret = crypto.randomUUID();
  const config = kind === "password"
    ? { auth_type: "password", username, password_hash: await hashPassword(password), secret_key: secret }
    : { auth_type: "none" };
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify(config));
  await Deno.mkdir(`${state}/plugins/session-guard`, { recursive: true });
  const inline = ["inline-core", "cross-browser", "pending-recovery", "menu-parity", "editor-source", "editor-wysiwyg"].includes(label);
  await Deno.writeTextFile(`${state}/plugins/session-guard/manifest.json`, JSON.stringify({ id: "session-guard", runtime: { server: "service.js", ...(inline ? { client: "browser.js" } : {}) }, hooks: ["pre-save", ...(label === "cross-browser" ? ["on-save"] : [])],
    ...(inline ? { settings: [{ id: "preferences", label: "Native preferences", renderer: { kind: "declarative-v1", version: 1 }, fields: [
      { key: "message", label: "Message", type: "text", default: "seed" }, { key: "limit", label: "Limit", type: "number", default: 5, min: 1, max: 10 }, { key: "protect", label: "Protect", type: "toggle", default: false },
      { key: "folder", label: "Folder", type: "folder", default: "" }, { key: "file", label: "File", type: "file", default: "" },
      { key: "notes", label: "Notes", type: "textarea", default: "seed lines" }, { key: "choice", label: "Choice", type: "select", default: false, options: [{label:"Off mode",value:false},{label:"Enabled mode",value:true}] },
      { key: "level", label: "Level", type: "slider", default: 5, min: 0, max: 10, step: 1 }, { key: "color", label: "Color", type: "color", default: "#aabbcc", visibleWhen: {field:"choice",equals:true} },
    ], groups: [{id:"main",label:"Main preferences",fields:["message","limit","protect"]},{id:"paths",label:"Host path choices",description:"Existing vault note/tree identities",fields:["folder","file"]},{id:"controls",label:"Typed controls",fields:["notes","choice","level","color"]}] }] } : {}) }));
  if (inline) { await Deno.mkdir(`${vault}/Chosen`); await Deno.writeTextFile(`${vault}/Chosen/Inside.md`, "Field choice content.\n"); }
  if (label === "cross-browser") await Deno.writeTextFile(`${vault}/Persistence.md`, "Persistence seed.\n");
  await Deno.writeTextFile(`${state}/plugins/session-guard/service.js`, `let reportRuns=0;export function activate(ctx) {
    ctx.hooks.on('pre-save', async fact => (fact.proposed?.content ?? '').includes('GPS-blocked') && (${inline ? "(await ctx.settings.read()).values.preferences.protect" : "true"}) ? {cancel:true,reason:'session guard protection'} : {cancel:false});
    ${label === "cross-browser" ? "ctx.hooks.on('on-save',async fact=>{const values=(await ctx.settings.read()).values.preferences;const data=await ctx.data.load();await ctx.data.save({hookRuns:(data.values.hookRuns??0)+1,hookLast:{message:values.message,limit:values.limit,protect:values.protect,path:fact.path,content:fact.after?.content}},data.revision);});" : ""}
    ${inline ? "ctx.commands.register({id:'report',label:'Native settings report',target:'server'},async()=>{reportRuns++;const values=(await ctx.settings.read()).values.preferences;return {message:values.message,limit:values.limit,protect:values.protect,...(await ctx.data.load()).values};});ctx.commands.register({id:'report-count',label:'Native report count',target:'server'},()=>reportRuns);" : ""}
  }`);
  if (inline) await Deno.writeTextFile(`${state}/plugins/session-guard/browser.js`, `export function activate(ctx) {
    const output=document.createElement('output');output.dataset.nativeSettingsConsumer='';output.setAttribute('role','status');output.style.cssText='position:fixed;right:16px;bottom:16px;';
    ctx.register(()=>output.remove());
    window.__settingsPeerThemeEvents??=0;ctx.events.on('theme:change',()=>window.__settingsPeerThemeEvents++);
    ctx.commands.register({id:'sdk-settings',label:'Native SDK Settings'},()=>ctx.actions.dispatch('app:open-settings',{page:'plugin:session-guard:preferences'}));
    ctx.commands.register({id:'consumer',label:'Native Settings Consumer'},async()=>{const settings=await ctx.settings.read('preferences');output.textContent=settings.values.message;if(!output.isConnected)document.body.append(output);return settings.values.message;});
  }`);
  if (["cross-browser", "menu-parity"].includes(label)) { await Deno.mkdir(`${state}/plugins/session-guard/endpoints/ping`, { recursive: true }); await Deno.writeTextFile(`${state}/plugins/session-guard/endpoints/ping/get.js`, "export default ()=>({available:true});"); }
  const token = kind === "password" ? await new SignJWT({ sub: username }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(secret)) : null;
  const directory = `${artifacts}/${label}`;
  await Deno.mkdir(directory);
  server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "" }, logsDir: directory, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (label === "cross-browser") server = createSettingsRestartFixture({ initialServer: server, directory, launch: async count => {
    const logsDir=`${directory}/backend-${count}`;await Deno.mkdir(logsDir);
    return bootServer(vault,state,{env:{GLOBNOTES_AUTH_TYPE:""},logsDir,headers:{authorization:`Bearer ${token}`}});
  } });
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9333) });
  const owned = { label, directory, vault, state, server, session, closed: false };
  fixtures.push(owned);
  await Deno.writeTextFile(`${directory}/ownership.json`, JSON.stringify({
    label, vault, state, pid: server.pid, baseUrl: server.baseUrl,
    targetId: session.targetId, browserContextId: session.browserContextId,
    activeFixtureCount: fixtures.filter(item => !item.closed).length,
  }, null, 2), { createNew: true });
  await session.goto(`${server.baseUrl}/NoteA`);
  if (kind === "password") {
    await session.poll("!!document.querySelector('#username')");
    await session.click("#username"); await session.type(username);
    await session.click("#password"); await session.type(password);
    await session.button("Log In");
  }
  await session.poll("!!document.querySelector('.toast-viewer')");
}
async function edit(marker) {
  await session.button("Edit", ".content-column");
  await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await session.click(".cm-content"); await session.type(marker + "\n");
  await session.poll(`document.querySelector('.cm-content')?.textContent.includes(${JSON.stringify(marker)})`);
  await session.evaluate("window.__gpsEditor = document.querySelector('.cm-content'); window.__gpsToken = sessionStorage.getItem('token'); true");
}
async function settings(page) {
  await session.click('[title="Open sidebar"]');
  await session.poll("!!document.querySelector('[aria-label=Settings]')");
  await session.click('[aria-label="Settings"]');
  await session.poll("!!document.querySelector('#settings-modal-title')");
  await session.button(page);
}
function note() {
  return session.evaluate("fetch('/_/api/notes/NoteA').then(async r => ({status:r.status, ...(await r.json())}))");
}
async function record(name) {
  assert(session.errors.length === 0, "Browser exception during session handoff");
  const owned = fixtures.at(-1);
  const outcome = { name, passed: true, targetId: session.targetId, browserContextId: session.browserContextId };
  await Deno.writeTextFile(`${owned.directory}/outcome.json`, JSON.stringify({
    ...outcome, pageErrors: session.errors, events: session.events,
  }, null, 2), { createNew: true });
  await owned.session.close();
  await owned.server.close();
  owned.closed = true;
  const response = await fetch(`http://127.0.0.1:${Deno.env.get("CDP_PORT") ?? 9333}/json/list`, { signal: AbortSignal.timeout(5000) });
  assert(response.ok, "Cannot verify successful fixture target closure");
  assert(!(await response.json()).some(target => target.id === owned.session.targetId), "Successful fixture target remains open");
  let serverConnectionClosed = false;
  try {
    const health = await fetch(`${owned.server.baseUrl}/_/api/health`, { signal: AbortSignal.timeout(5000) });
    await health.body?.cancel();
  } catch (error) { if (!(error instanceof TypeError)) throw error; serverConnectionClosed = true; }
  assert(serverConnectionClosed, "Successful fixture server still accepts connections");
  await Deno.writeTextFile(`${owned.directory}/closure.json`, JSON.stringify({
    targetClosed: true, serverClosed: true, activeFixtureCount: fixtures.filter(item => !item.closed).length,
  }, null, 2), { createNew: true });
  outcomes.push(outcome);
  console.log(`ok: ${name}`);
}
try {
  await fixture("none", "inline-core");
  await edit("GPS inline dirty marker");
  const inlineOutcomes = await exerciseInlineSettings({ session, server, vault, state, directory: fixtures.at(-1).directory });
  await Deno.writeTextFile(`${artifacts}/inline-core/consumers.json`, JSON.stringify(inlineOutcomes, null, 2), { createNew: true });
  await record("inline-core-native-consumers");
  await fixture("password", "cross-browser");
  await edit("GPS cross-browser dirty marker");
  const peers = await exerciseSettingsCrossBrowser({ session, server, directory: fixtures.at(-1).directory, username, password, vault, state });
  await Deno.writeTextFile(`${artifacts}/cross-browser/consumers.json`, JSON.stringify(peers, null, 2), { createNew: true });
  await record("independent-browser-settings-recovery-and-contributions");
  await fixture("none", "pending-recovery");
  await edit("GPS pending dirty marker");
  const pending = await exerciseSettingsPending({ session, server, directory: fixtures.at(-1).directory });
  await Deno.writeTextFile(`${artifacts}/pending-recovery/consumers.json`, JSON.stringify(pending, null, 2), { createNew: true });
  await record("native-pending-wire-and-lost-acknowledgement-recovery");
  await fixture("none", "menu-parity");
  const menu = await exerciseSettingsMenu({ session, server, state });
  await Deno.writeTextFile(`${artifacts}/menu-parity/consumers.json`, JSON.stringify(menu, null, 2), { createNew: true });
  await record("native-editor-debug-policy-and-search-sort-menu-consumers");
  for (const mode of ["Source", "WYSIWYG"]) {
    const label = `editor-${mode.toLowerCase()}`;
    await fixture("none", label);
    const editor = await exerciseSettingsEditor({ session, server, vault, mode });
    await Deno.writeTextFile(`${artifacts}/${label}/consumers.json`, JSON.stringify(editor, null, 2), { createNew: true });
    await record(`native-${mode.toLowerCase()}-buffer-properties-and-participation`);
  }
  await fixture("none", "geometry");
  await edit("GPS geometry dirty marker");
  const geometry = await exerciseSettingsGeometry({ session, directory: fixtures.at(-1).directory });
  await Deno.writeTextFile(`${artifacts}/geometry/consumers.json`, JSON.stringify(geometry, null, 2), { createNew: true });
  await record("settings-viewport-dpr-theme-native-geometry");
  await fixture("none", "open-dismiss");
  await edit("GPS immediate dirty marker");
  await settings("Access");
  await session.button("Change access mode");
  await session.poll("!!document.querySelector('#setup-title')");
  assert(await session.evaluate("document.querySelector('.cm-content') === window.__gpsEditor"), "Opening the optional wizard destroyed the dirty editor instance");
  assert(await session.evaluate("document.querySelector('.cm-content').textContent.includes('GPS immediate dirty marker')"), "Optional wizard lost typed content");
  await session.click('[aria-label="Dismiss setup"]');
  await session.poll("!document.querySelector('#setup-title')");
  assert(await session.evaluate("document.querySelector('.cm-content') === window.__gpsEditor"), "Dismissing optional wizard replaced the editor");
  await record("optional-wizard-open-dismiss");
  for (const choice of ["Cancel", "Discard", "Save", "Blocked Save"]) {
    const label = `wizard-${choice.toLowerCase().replaceAll(" ", "-")}`;
    await fixture("password", label);
    const blocked = choice === "Blocked Save";
    const marker = blocked ? "GPS-blocked wizard" : `GPS ${label}`;
    await edit(marker);
    await settings("Access");
    await session.button("Change access mode");
    await session.poll("!!document.querySelector('#access-current-password') && !document.querySelector('#setup-username').disabled && document.querySelector('#setup-username').value==='session-fixture'");
    await session.click("#setup-username"); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type("new-fixture");
    await session.click("#setup-password"); await session.type("new-fixture-secret");
    await session.click("#access-current-password"); await session.type(password);
    await session.button("Save access settings");
    await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')");
    assert(await session.evaluate("sessionStorage.getItem('token') === window.__gpsToken"), "Finish cleared credentials before permission");
    assert((await note()).content === "Seed content.\n", "Finish mutated disk before a decision");
    await session.button(blocked ? "Save" : choice, '[data-modal-top="true"]');
    if (choice === "Cancel" || blocked) {
      await session.poll("document.querySelector('#setup-title') && ![...document.querySelectorAll('.fixed.z-50')].some(el => el.textContent.includes('Save Changes'))");
      assert(await session.evaluate("document.querySelector('.cm-content') === window.__gpsEditor"), "Aborted Finish replaced editor");
      assert(await session.evaluate("sessionStorage.getItem('token') === window.__gpsToken"), "Aborted Finish cleared credentials");
      assert((await note()).content === "Seed content.\n", "Aborted Finish changed disk");
      const config = JSON.parse(await Deno.readTextFile(`${state}/config.json`));
      assert(config.username === username, "Aborted Finish reset authentication");
    } else {
      await session.poll("!!document.querySelector('#username') && !document.querySelector('#setup-title')");
      const disk = await Deno.readTextFile(`${vault}/NoteA.md`);
      assert(choice === "Save" ? disk.includes(marker) : disk === "Seed content.\n", "Finish Save/Discard disk outcome differs from decision");
      const config = JSON.parse(await Deno.readTextFile(`${state}/config.json`));
      assert(config.username === "new-fixture", "Approved Finish did not persist the new authentication");
    }
    await record(label);
  }
  for (const choice of ["Cancel", "Discard", "Save", "Blocked Save"]) {
    const label = `logout-${choice.toLowerCase().replaceAll(" ", "-")}`;
    await fixture("password", label);
    const blocked = choice === "Blocked Save";
    const marker = blocked ? "GPS-blocked logout" : `GPS ${label}`;
    await edit(marker);
    await settings("Account");
    await session.button("Log out");
    await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Save Changes')");
    assert(await session.evaluate("sessionStorage.getItem('token') === window.__gpsToken"), "Logout cleared credentials before permission");
    await session.button(blocked ? "Save" : choice, '[data-modal-top="true"]');
    if (choice === "Cancel" || blocked) {
      await session.poll("!!document.querySelector('#settings-modal-title') && ![...document.querySelectorAll('.fixed.z-50')].some(el => el.textContent.includes('Save Changes'))");
      assert(await session.evaluate("document.querySelector('.cm-content') === window.__gpsEditor"), "Aborted Logout replaced editor");
      assert(await session.evaluate("sessionStorage.getItem('token') === window.__gpsToken"), "Aborted Logout lost credentials");
      assert((await note()).content === "Seed content.\n", "Aborted Logout changed disk");
    } else {
      await session.poll("!!document.querySelector('#username') && !document.querySelector('#settings-modal-title')");
      assert(await session.evaluate("sessionStorage.getItem('token') === null && localStorage.getItem('token') === null"), "Approved Logout retained credentials");
      const disk = await Deno.readTextFile(`${vault}/NoteA.md`);
      assert(choice === "Save" ? disk.includes(marker) : disk === "Seed content.\n", "Logout Save/Discard disk outcome differs from decision");
    }
    await record(label);
  }
  console.log("GPS-11 SESSION HANDOFF OK (nine native cases)");
  console.log("SETTINGS SESSION PROBE OK (remaining matrix not yet run)");
} catch (error) { failure = error; console.error(`FAIL: ${error.message}`); }
finally {
  const report = { outcomes, failure: failure?.message, vault, state, server: server && { pid: server.pid, baseUrl: server.baseUrl }, targetId: session?.targetId, browserContextId: session?.browserContextId, pageErrors: session?.errors, events: session?.events };
  if (session && !fixtures.at(-1)?.closed) report.page = await session.evaluate("({url:location.href,body:document.body.innerText,editors:document.querySelectorAll('.cm-content,.ProseMirror').length})").catch(error => ({ error: error.message }));
  await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify(report, null, 2));
  console.log(`settings-ui diagnostics: ${artifacts}/diagnostics.json`);
  if (!failure) {
    for (const owned of fixtures.filter(item => !item.closed)) { await owned.session.close(); await owned.server.close(); }
  }
  if (failure) {
    const owned = fixtures.at(-1);
    if (owned && !owned.closed) {
      const picture = await owned.session.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
      if (picture) await Deno.writeFile(`${owned.directory}/failure.png`, Uint8Array.from(atob(picture.data), char => char.charCodeAt(0)), { createNew: true });
      await owned.session.close(); await owned.server.close(); owned.closed = true;
      await Deno.writeTextFile(`${owned.directory}/failed-fixture-closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true, failureCapturedBeforeClosure: true, filesRetained: true }), { createNew: true });
    }
  }
}
if (failure) throw failure;
