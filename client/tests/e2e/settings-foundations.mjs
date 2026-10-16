// Feature-owned real Settings foundation consumers; shared native helpers stay unchanged.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { applicationServer } from "./http-origin.mjs";

let options;
try { options = parseArguments(Deno.args); }
catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) {
  console.log("Usage: settings-foundations.mjs [--artifacts <fresh-directory>] [--help]");
  Deno.exit(0);
}
const artifacts = options.artifacts ?? await Deno.makeTempDir({ prefix: "settings-foundations-artifacts-" });
if (options.artifacts) await Deno.mkdir(artifacts, { mode: 0o700 });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const outcomes = [];
let session, server, vault, state, failure;
let removeObserver;
const writes = [];
const held = new Set();
let holdBrand = false, heldBrand = null;
let rejectPermissionWrite = false;
const brandPath = "/_/api/brand";
const permissionPath = "/_/api/plugin-host/foundation-guard/permissions";
// The permission-warning fixture needs an actually unavailable import parent.
// Match the existing feature-owned plugin-permissions.mjs parent-launch pattern;
// bootServer's general default and the production runtime remain unchanged.
async function bootWarningServer(vault, state, logsDir) {
  const root = new URL("../../..", import.meta.url).pathname;
  const { host, origin } = applicationServer();
  const listener = Deno.listen({ hostname: host, port: 0 });
  const port = listener.addr.port; listener.close();
  const args = ["run", "--cached-only", "--frozen", `--config=${root}/deno.json`, "--unstable-worker-options", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-import=jsr.io:443", `${root}/server/main.ts`];
  const child = new Deno.Command(Deno.execPath(), { args, cwd: root, clearEnv: true, stdout: "piped", stderr: "piped", env: {
    PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "", NO_COLOR: "1", GLOBNOTES_PATH: vault, GLOBNOTES_INDEX_PATH: state, GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_HOST: host, GLOBNOTES_PORT: String(port),
  } }).spawn();
  const drains = ["stdout", "stderr"].map(async channel => {
    const file = await Deno.open(`${logsDir}/server-${channel}.log`, { write: true, createNew: true });
    try { for await (const bytes of child[channel]) { let offset = 0; while (offset < bytes.length) offset += await file.write(bytes.subarray(offset)); } }
    finally { file.close(); }
  });
  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    try { child.kill("SIGTERM"); } catch { /* owned child already exited */ }
    let timer;
    const status = await Promise.race([child.status, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
    clearTimeout(timer);
    if (!status) { try { child.kill("SIGKILL"); } catch { /* owned child already exited */ } await child.status; }
    await Promise.all(drains);
  }
  const baseUrl = origin(port);
  try {
    await Deno.writeTextFile(`${logsDir}/parent.json`, JSON.stringify({ pid: child.pid, args, cwd: root, explicitImportParent: true }, null, 2), { createNew: true });
    const healthDeadline = Date.now() + 30000;
    for (;;) {
      try { const response = await fetch(`${baseUrl}/_/api/health`, { signal: AbortSignal.timeout(5000) }); await response.body?.cancel(); if (response.ok) break; }
      catch { /* bounded owned startup */ }
      assert(Date.now() < healthDeadline, "Owned warning fixture health deadline");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const readyDeadline = Date.now() + 15000;
    for (;;) {
      const response = await fetch(`${baseUrl}/_/api/plugin-host`, { signal: AbortSignal.timeout(5000) });
      assert(response.ok, "Owned warning fixture catalog rejected");
      const catalog = await response.json();
      const fixture = catalog.plugins.find(plugin => plugin.id === "foundation-guard");
      assert(fixture?.status !== "failed", `Owned warning fixture activation failed: ${JSON.stringify(fixture)}`);
      if (fixture?.enabled && fixture.status === "ready" && catalog.plugins.every(plugin => !plugin.enabled || !plugin.runtime?.server || plugin.status === "ready")) break;
      assert(Date.now() < readyDeadline, "Owned warning fixture plugin readiness deadline");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) { await close(); throw error; }
  return { pid: child.pid, baseUrl, close };
}
async function record(name, detail) {
  const outcome = { name, ...detail };
  await Deno.writeTextFile(`${artifacts}/${name}.json`, JSON.stringify(outcome, null, 2), { createNew: true });
  outcomes.push(outcome);
  console.log(`ok: ${name}`);
}
async function screenshot(name) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  const path = `${artifacts}/${name}.png`;
  await Deno.writeFile(path, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { createNew: true });
  return path;
}
const inspect = expression => session.evaluate(expression);
const settled = () => inspect("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
async function replace(selector, value) {
  await session.click(selector);
  await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  if (value) await session.type(value);
  else await session.key("Backspace", { windowsVirtualKeyCode: 8 });
}
async function enabledButton(label, scope) {
  await session.poll(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(el=>el.textContent.trim()===${JSON.stringify(label)} && !el.disabled && !el.closest('[inert]'));if(!button)return false;button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();return !!r.width && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
  await session.button(label, scope);
}
async function open() {
  if (await inspect("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
  await session.click('[aria-label="Settings"]');
  await session.poll("!!document.querySelector('#settings-modal-title')");
}
async function close() {
  await session.click('[aria-label="Close settings"]');
  await session.poll("!document.querySelector('#settings-modal-title') && document.activeElement===document.querySelector('[aria-label=Settings]')");
}
async function theme(id) {
  await session.button("Appearance", '[aria-label="Settings pages"]');
  await session.click(`[data-theme-id="${id}"]`);
  await session.poll(`localStorage.getItem('globnotes-theme')===${JSON.stringify(id)}`);
  await settled();
}
async function tabTo(selector) {
  for (let count = 0; count < 60; count++) {
    await session.key("Tab", { windowsVirtualKeyCode: 9 });
    if (await inspect(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)) {
      return inspect(`(()=>{const el=document.activeElement,s=getComputedStyle(el);return {selector:${JSON.stringify(selector)},focusVisible:el.matches(':focus-visible'),outlineStyle:s.outlineStyle,outlineWidth:parseFloat(s.outlineWidth),outlineColor:s.outlineColor,themeText:'rgb('+getComputedStyle(document.documentElement).getPropertyValue('--theme-text').trim().split(/\\s+/).join(', ')+')',type:el.type};})()`);
    }
  }
  throw new Error(`Keyboard did not reach ${selector}`);
}
function focusAssertion(result) {
  assert(result.focusVisible && result.outlineStyle === "solid" && result.outlineWidth >= 2 && result.outlineColor === result.themeText, `input-focus contract: ${JSON.stringify(result)}`);
}
async function actions(scope, name) {
  await inspect(`document.querySelector(${JSON.stringify(scope + " [data-settings-actions]")})?.scrollIntoView({block:'center'})`);
  await settled();
  const result = await inspect(`(()=>{
    const box=document.querySelector(${JSON.stringify(scope + " [data-settings-actions]")});
    if(!box)return {missing:true};
    const r=box.getBoundingClientRect(),style=getComputedStyle(box),rem=parseFloat(getComputedStyle(document.documentElement).fontSize);
    const rect=el=>el.getBoundingClientRect().toJSON();
    const collect=zone=>[...box.querySelectorAll(zone+' button')].map(el=>{
      const s=getComputedStyle(el),label=el.querySelector('.icon-label-wrap > span'),lr=label?.getBoundingClientRect();
       const br=el.getBoundingClientRect();return {text:el.textContent.trim(),rect:br.toJSON(),type:el.type,disabled:el.disabled,opacity:parseFloat(s.opacity),paddingX:parseFloat(s.paddingLeft),paddingY:parseFloat(s.paddingTop),fontWeight:s.fontWeight,fontSize:s.fontSize,lineHeight:parseFloat(s.lineHeight),whiteSpace:s.whiteSpace,color:s.color,borderColor:s.borderTopColor,background:s.backgroundColor,labelRect:lr?.toJSON(),hit:el.contains(document.elementFromPoint(br.x+br.width/2,br.y+br.height/2))};
    });
    const dialog=box.closest('[role=dialog]');
    return {rect:r.toJSON(),start:rect(box.querySelector('[data-settings-actions-start]')),end:rect(box.querySelector('[data-settings-actions-end]')),left:collect('[data-settings-actions-start]'),right:collect('[data-settings-actions-end]'),gap:parseFloat(style.columnGap),rem,display:style.display,overflow:dialog.scrollWidth-dialog.clientWidth,fontsReady:document.fonts.status==='loaded',themeDanger:'rgb(225, 29, 72)',themeBrand:'rgb('+getComputedStyle(document.documentElement).getPropertyValue('--theme-brand').trim().split(/\\s+/).join(', ')+')'};
  })()`);
  assert(!result.missing, `${name}: missing structural action zones`);
  assert(result.display === "grid" && result.gap >= result.rem - 0.5, `${name}: persistent one-rem gap missing`);
  assert(result.left.length > 0 && result.right.length > 0, `${name}: paired consumer is missing its actions`);
  assert(result.fontsReady && result.overflow <= 1, `${name}: fonts/overflow contract`);
  assert(Math.abs(result.end.right - result.rect.right) <= 0.5, `${name}: end zone not right aligned`);
  assert(result.right.every(button => Math.abs(button.rect.right - result.rect.right) <= 0.5), `${name}: end actions not right aligned`);
  assert(result.right[0].rect.left - Math.max(...result.left.map(button => button.rect.right)) >= result.gap - 0.5, `${name}: action separation lost`);
  for (const [zone, buttons] of [[result.start, result.left], [result.end, result.right]]) {
    for (const button of buttons) {
      assert(button.rect.left >= zone.left - 0.5 && button.rect.right <= zone.right + 0.5, `${name}: ${button.text} escapes zone`);
      assert(button.paddingX === result.rem && button.paddingY === result.rem * 0.625 && Number(button.fontWeight) === 600, `${name}: ${button.text} is not canonical CTA geometry`);
      assert(button.type === "button" && button.whiteSpace !== "nowrap", `${name}: type/wrap contract lost`);
      assert(button.disabled ? button.opacity === 0.4 : button.hit, `${name}: disabled presentation/hit contract lost`);
      if (button.labelRect) assert(button.labelRect.right <= button.rect.right + 0.5, `${name}: visible label escaped`);
      if (["Reset", "Discard"].includes(button.text)) assert(button.color === result.themeDanger && button.borderColor === result.themeDanger, `${name}: danger semantics lost`);
      else assert(button.background === result.themeBrand && button.color === "rgb(255, 255, 255)", `${name}: primary theme treatment lost`);
    }
  }
  return result;
}
async function invariant() {
  assert(await inspect("document.querySelector('.cm-content')===window.__foundationEditor && document.querySelector('.cm-content').textContent.includes('Foundation unsaved note') && sessionStorage.getItem('token')===window.__foundationToken"), "Foundation interaction replaced editor/token or lost note draft");
  assert(await Deno.readTextFile(`${vault}/NoteA.md`) === "Seed content.\n", "Foundation interaction wrote the unsaved note");
}
async function closeFixture(name) {
  // nativeSession.close owns an idempotent dispose; server closure is independent
  // even if CDP disposal reports an error. A cleanup error still rejects the run.
  try { await session.close(); }
  finally { await server.close(); }
  const targets = await fetch(`http://127.0.0.1:${Deno.env.get("CDP_PORT") ?? 9335}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  assert(!targets.some(target => target.id === session.targetId), "Owned foundation target remains open");
  let closed = false;
  try { const response = await fetch(`${server.baseUrl}/_/api/health`, { signal: AbortSignal.timeout(5000) }); await response.body?.cancel(); }
  catch (error) { if (!(error instanceof TypeError)) throw error; closed = true; }
  assert(closed, "Owned foundation server still accepts connections");
  await Deno.writeTextFile(`${artifacts}/${name}.json`, JSON.stringify({ targetId: session.targetId, serverPid: server.pid, targetClosed: true, serverClosed: true, filesRetained: true, failureCapturedBeforeClosure: !!failure }), { createNew: true });
}
// Read actual compiled colors at real call sites. Contrast is against both inherited surfaces.
async function warningObservation(selector, kind) {
  await session.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
  await inspect(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  await settled();
  const row = await inspect(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(el),root=getComputedStyle(document.documentElement);
    const rgb=value=>(value.match(/[\\d.]+/g)??[]).slice(0,3).map(Number);
    const luminance=values=>values.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    const token=rgb(root.getPropertyValue('--theme-warning')),color=rgb(${JSON.stringify(kind)}==='text'?s.color:s.borderTopColor);
    const surfaces=['background','background-elevated'].map(name=>{const background=rgb(root.getPropertyValue('--theme-'+name));return {name,background,contrast:contrast(color,background)};});
    const r=el.getBoundingClientRect();return {selector:${JSON.stringify(selector)},kind:${JSON.stringify(kind)},text:el.textContent.trim(),token,color,surfaces,borderWidth:parseFloat(s.borderTopWidth),rect:r.toJSON(),visible:!!r.width&&!!r.height,badgeText:el.matches('[data-plugin-browser-badge]')?rgb(s.color):null,themeText:rgb(root.getPropertyValue('--theme-text'))};
  })()`);
  assert(row.visible && row.token.length === 3 && row.color.length === 3 && row.color.every((value, index) => value === row.token[index]), `warning-token contract: ${JSON.stringify(row)}`);
  for (const surface of row.surfaces) assert(surface.contrast >= (kind === "text" ? 4.5 : 3), `warning contrast ${selector}/${surface.name}: ${surface.contrast}`);
  if (kind === "border") assert(row.borderWidth >= 1, `warning border not painted: ${selector}`);
  if (row.badgeText) assert(row.badgeText.every((value, index) => value === row.themeText[index]), "Browser badge text no longer uses theme-text");
  return row;
}
try {
  vault = await Deno.makeTempDir({ prefix: "settings-foundations-vault-" });
  state = await Deno.makeTempDir({ prefix: "settings-foundations-state-" });
  await Deno.writeTextFile(`${vault}/NoteA.md`, "Seed content.\n");
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: "none", brand_name: "Foundation seed" }));
  await Deno.mkdir(`${state}/plugins/foundation-guard`, { recursive: true });
  await Deno.writeTextFile(`${state}/plugins/foundation-guard/manifest.json`, JSON.stringify({
    id: "foundation-guard", name: "Foundation warning consumer", runtime: { server: "service.js", client: "browser.js" }, hooks: ["pre-save"],
    capabilities: { network: true, imports: ["foundation.invalid:443"], read: ["vault"], write: [] },
    settings: [{ id: "preferences", label: "Foundation preferences", renderer: { kind: "declarative-v1", version: 1 }, fields: [{ key: "message", label: "Message", type: "text", default: "seed" }] }],
  }));
  await Deno.writeTextFile(`${state}/plugins/foundation-guard/service.js`, "export function activate(ctx){ctx.hooks.on('pre-save',()=>({cancel:false}));ctx.commands.register({id:'request',label:'Request foundation consent',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:true,reason:'Foundation broad-access warning consumer'}));}");
  await Deno.writeTextFile(`${state}/plugins/foundation-guard/browser.js`, "export function activate(){}");
  server = await bootWarningServer(vault, state, artifacts);
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
  await Deno.writeTextFile(`${artifacts}/ownership.json`, JSON.stringify({ vault, state, server: { pid: server.pid, baseUrl: server.baseUrl }, targetId: session.targetId, browserContextId: session.browserContextId }, null, 2), { createNew: true });
  removeObserver = session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && !["GET", "HEAD"].includes(event.params.request.method)) writes.push({ path: new URL(event.params.request.url).pathname, method: event.params.request.method });
    if (event.method !== "Fetch.requestPaused") return;
    const paused = event.params;
    if (rejectPermissionWrite && new URL(paused.request.url).pathname === permissionPath && paused.request.method === "PUT") {
      rejectPermissionWrite = false;
      session.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "ConnectionClosed" }).catch(error => { failure ??= error; });
      return;
    }
    if (holdBrand && new URL(paused.request.url).pathname === brandPath && paused.request.method === "POST") {
      holdBrand = false; heldBrand = paused; held.add(paused.requestId);
    } else session.send("Fetch.continueRequest", { requestId: paused.requestId }).catch(error => { failure ??= error; });
  });
  await session.goto(`${server.baseUrl}/NoteA`);
  await session.poll("!!document.querySelector('.toast-viewer')");
  await session.button("Edit", ".content-column");
  await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await session.click(".cm-content"); await session.type("Foundation unsaved note\n");
  await session.poll("document.querySelector('.cm-content').textContent.includes('Foundation unsaved note')");
  await inspect("window.__foundationEditor=document.querySelector('.cm-content');window.__foundationToken=sessionStorage.getItem('token');true");
  await open();
  const themeIds = await inspect("(()=>{const ids=[...document.querySelectorAll('[data-theme-id]')].map(el=>el.dataset.themeId);return ids.filter(id=>id!=='system');})()");
  assert(themeIds.length === 15, `Expected 15 shipped explicit themes, got ${themeIds.length}`);
  for (const id of themeIds) {
    await theme(id);
    await session.button("Plugins", '[aria-label="Settings pages"]');
    const observations = [
      await warningObservation('[data-plugin-inventory-id="foundation-guard"] .text-theme-warning', "text"),
      await warningObservation('[data-plugin-inventory-id="foundation-guard"] [data-plugin-browser-badge]', "border"),
    ];
    await session.button("Foundation preferences", '[aria-label="Settings pages"]');
    observations.push(await warningObservation('[role="note"].border-theme-warning', "border"));
    await session.click('[data-permission-page="foundation-guard"]');
    observations.push(await warningObservation('[data-permission-kind="network"][data-permission-scope="all"] .text-theme-warning', "text"));
    await invariant();
    await record(`warning-${id}`, { observations, screenshot: await screenshot(`warning-${id}`) });
  }
  assert(writes.length === 0, "Theme/warning navigation issued mutations");
  for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 900 }]) {
    for (const dpr of [1, 2]) for (const mode of ["light", "dark"]) {
      const name = `foundation-${viewport.width}-dpr-${dpr}-${mode}`;
      await session.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: dpr, mobile: false });
      await theme(`globnotes-${mode}`);
      await session.button("Branding", '[aria-label="Settings pages"]');
      await session.poll("document.querySelector('#brand-name')?.value==='Foundation seed'");
      const clean = await actions("[data-branding-settings]", `${name}-clean`);
      assert(clean.right.find(button => button.text === "Save").disabled, "Clean Branding Save is enabled");
      const inputFocus = await tabTo("#brand-name"); focusAssertion(inputFocus);
      await replace("#brand-name", `Foundation retained draft ${name}`);
      await session.poll("[...document.querySelectorAll('[data-branding-settings] button')].some(b=>b.textContent.trim()==='Save'&&!b.disabled)");
      await session.button("Appearance", '[aria-label="Settings pages"]');
      await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
       const departure = await actions('[data-modal-top="true"]', `${name}-departure`);
       assert(departure.left[0].text === "Keep editing" && departure.right.some(button => button.text === "Discard"), "Grouped departure lost decision semantics");
       if (viewport.width === 320) assert(departure.left[0].labelRect.height > departure.left[0].lineHeight, "Narrow CTA label did not actually wrap");
      const screenshotPath = await screenshot(`${name}-departure`);
      // Native Tab/Shift+Tab, Space, Escape and restored opener in the actual topmost modal.
      const ctaFocus = await tabTo('[data-modal-top="true"] [data-settings-actions-start] button'); focusAssertion(ctaFocus);
      await session.key("Tab", { modifiers: 8, windowsVirtualKeyCode: 9 });
      await session.poll("document.activeElement===document.querySelector('[data-modal-top=true] [data-settings-actions-end] button:last-child')");
      await session.key("Tab", { windowsVirtualKeyCode: 9 });
      await session.poll("document.activeElement===document.querySelector('[data-modal-top=true] [data-settings-actions-start] button')");
      await session.key(" ", { code: "Space", windowsVirtualKeyCode: 32 });
      await session.poll("!document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings') && document.activeElement?.textContent.trim()==='Appearance'");
      assert(await inspect(`document.querySelector('#brand-name').value===${JSON.stringify(`Foundation retained draft ${name}`)}`), "Keep editing lost Branding draft");
      await session.button("Reset", "[data-branding-settings]");
      await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Reset branding?')");
      const reset = await actions('[data-modal-top="true"]', `${name}-reset`);
      const resetScreenshot = await screenshot(`${name}-reset`);
      if (dpr === 1) {
        await tabTo('[data-modal-top="true"] [data-settings-actions-start] button');
        for (const type of ["keyDown", "keyUp"]) await session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      } else await session.key("Escape", { windowsVirtualKeyCode: 27 });
      await session.poll("!document.querySelector('[data-modal-top=true]').textContent.includes('Reset branding?') && document.activeElement?.textContent.trim()==='Reset'");
      await session.button("Appearance", '[aria-label="Settings pages"]');
      await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
      await session.button("Discard", '[data-modal-top="true"]');
      await session.poll("!!document.querySelector('[data-appearance-settings]')");
      await session.button("Access", '[aria-label="Settings pages"]');
      await session.button("Change access mode");
      await session.poll("!!document.querySelector('#setup-title') && !document.querySelector('#setup-mode-password').disabled");
      await session.click("#setup-mode-password");
      const accessFocus = await tabTo("#setup-username"); focusAssertion(accessFocus);
      await replace("#setup-username", "foundation-proposal");
      await session.click("#setup-mode-none");
      const toggleFocus = await tabTo("#setup-read-only-settings"); focusAssertion(toggleFocus);
      const previous = await inspect("document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')");
      await session.key(" ", { code: "Space", windowsVirtualKeyCode: 32 });
      await session.poll(`document.querySelector('#setup-read-only-settings').getAttribute('aria-checked')!==${JSON.stringify(previous)}`);
      const submit = await inspect("(()=>{const b=document.querySelector('#setup-title').closest('[role=dialog]').querySelector('button[type=submit]'),s=getComputedStyle(b);return {type:b.type,disabled:b.disabled,opacity:parseFloat(s.opacity),padding:parseFloat(s.paddingTop),busy:b.getAttribute('aria-busy')};})()");
      assert(submit.type === "submit" && submit.disabled && submit.opacity === 0.4 && submit.padding === 10, "Access CTA lost form ownership/disabled treatment");
      const accessScreenshot = await screenshot(`${name}-access`);
      await session.key("Escape", { windowsVirtualKeyCode: 27 });
      await session.poll("!document.querySelector('#setup-title')");
      await invariant();
      assert(writes.length === 0, "Cancel/Reset/departure/Access draft issued mutations");
      await open();
      await record(name, { viewport, dpr, mode, clean, inputFocus, ctaFocus, departure, reset, accessFocus, toggleFocus, submit, screenshots: [screenshotPath, resetScreenshot, accessScreenshot], editorDraftRetained: await inspect("document.querySelector('.cm-content')===window.__foundationEditor"), navigationWrites: writes.length });
    }
  }
  // Hold only the owned Branding response: persist A, type B, then acknowledge A.
  await theme("globnotes-light");
  await session.button("Branding", '[aria-label="Settings pages"]');
  await session.poll("document.querySelector('#brand-name')?.value==='Foundation seed'");
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `*${brandPath}`, requestStage: "Response" }] });
  holdBrand = true;
  await replace("#brand-name", "Foundation persisted A");
  await session.button("Save", "[data-branding-settings]");
  const deadline = Date.now() + 15000;
  while (!heldBrand) { assert(Date.now() < deadline, "Owned Branding response did not arrive"); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(heldBrand.responseStatusCode === 200, "Held Branding write failed upstream");
  await replace("#brand-name", "Foundation newer B");
  assert(await inspect("!document.querySelector('#brand-name').readOnly && !document.querySelector('#brand-name').disabled"), "Pending Branding disabled newer draft editing");
  const persisted = JSON.parse(await Deno.readTextFile(`${state}/config.json`));
  assert(persisted.brand_name === "Foundation persisted A", "Held Branding response did not persist captured A");
  await session.send("Fetch.continueRequest", { requestId: heldBrand.requestId }); held.delete(heldBrand.requestId);
  await session.poll("document.querySelector('#brand-name').value==='Foundation newer B' && !document.querySelector('[data-branding-settings] [role=status]')");
  await session.send("Fetch.disable");
  await invariant();
  assert(writes.length === 1 && writes[0].path === brandPath, "Branding newer-draft flow repeated a mutation");
  await record("branding-pending-newer-draft", { capturedPersisted: persisted.brand_name, newerVisible: "Foundation newer B", writes, screenshot: await screenshot("branding-pending-newer-draft") });
  await session.button("Appearance", '[aria-label="Settings pages"]');
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  await session.button("Discard", '[data-modal-top="true"]');
  await session.poll("!!document.querySelector('[data-appearance-settings]')");
  await close();
  await invariant();
  // Confirm Reset through the changed danger CTA, then observe disk/API/reopened UI.
  await open();
  await session.button("Branding", '[aria-label="Settings pages"]');
  await session.poll("document.querySelector('#brand-name')?.value==='Foundation persisted A'");
  await session.button("Reset", "[data-branding-settings]");
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Reset branding?')");
  assert(writes.length === 1, "Reset sent a write before explicit confirmation");
  await session.button("Reset", '[data-modal-top="true"]');
  await session.poll("document.querySelector('#brand-name')?.value==='' && !document.querySelector('[data-branding-settings] [role=status]')");
  const resetConfig = JSON.parse(await Deno.readTextFile(`${state}/config.json`));
  const resetApi = await fetch(`${server.baseUrl}/_/api/config`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  assert(!resetConfig.brand_name && !resetConfig.brand_accent && !resetApi.brand.name && !resetApi.brand.accent && !resetApi.brand.files.length, "Reset did not clear persisted/API branding");
  await close(); await open();
  await session.button("Branding", '[aria-label="Settings pages"]');
  await session.poll("document.querySelector('#brand-name')?.value===''");
  assert(writes.length === 2 && writes.every(write => write.path === brandPath), "Reset duplicated or misdirected its write");
  await invariant();
  await record("branding-reset-confirmed", { resetConfig: { name: resetConfig.brand_name, accent: resetConfig.brand_accent }, apiBrand: resetApi.brand, reopenedName: "", writes: [...writes], screenshot: await screenshot("branding-reset-confirmed") });

  // Real import approval under the unchanged parent cannot confer remote imports.
  await session.button("Plugins", '[aria-label="Settings pages"]');
  await session.click('[data-permission-page="foundation-guard"]');
  const importRow = '[data-permission-kind="imports"][data-permission-scope="host:foundation.invalid:443"]';
  await enabledButton("Approve", importRow);
  await session.poll(`document.querySelector(${JSON.stringify(importRow)})?.textContent.includes('Delete approval')`);
  await enabledButton("Allow network", "[data-plugin-permission-panel]");
  await session.poll(`document.querySelector(${JSON.stringify(importRow)})?.textContent.includes('parent unavailable')`);
  const permissionView = async () => {
    const response = await fetch(`${server.baseUrl}${permissionPath}`, { signal: AbortSignal.timeout(5000) });
    assert(response.ok, "Authoritative permission view rejected"); return response.json();
  };
  const unavailable = await permissionView();
  assert(unavailable.allowNetwork && unavailable.approvedImports.length === 1 && !unavailable.effectiveImports.length && unavailable.rows.some(row => row.kind === "imports" && row.blockedReasons.includes("parent-unavailable")), "Parent-unavailable fixture did not preserve the real authority boundary");
  for (const id of themeIds) {
    await theme(id);
    await session.button("Plugins", '[aria-label="Settings pages"]');
    await session.click('[data-permission-page="foundation-guard"]');
    const parentWarning = await warningObservation(`${importRow} .text-theme-warning`, "text");
    // Reject only the next owned wire before effect; the actual controller retains its choice.
    const before = await permissionView();
    await session.send("Fetch.enable", { patterns: [{ urlPattern: `*${permissionPath}`, requestStage: "Request" }] });
    rejectPermissionWrite = true;
    await enabledButton("Allow network", "[data-plugin-permission-panel]");
    await session.poll("[...document.querySelectorAll('[data-plugin-permission-panel] button')].some(b=>b.textContent.trim()==='Discard permission choice'&&!b.disabled)");
    assert(!rejectPermissionWrite, "Retained-choice fixture never reached its owned wire");
    await session.send("Fetch.disable");
    const retainedWarning = await warningObservation("[data-plugin-permission-panel] > div.border-theme-warning", "border");
    assert(retainedWarning.text.includes("Your permission choices are retained."), "Retained-warning observation targeted another warning consumer");
    const after = await permissionView();
    assert(before.revision === after.revision && after.allowNetwork, "Rejected permission wire changed authority");
    await invariant();
    await record(`permission-warning-${id}`, { observations: [parentWarning, retainedWarning], unchangedRevision: after.revision, expectedTransportFailure: "ConnectionClosed", screenshot: await screenshot(`permission-warning-${id}`) });
    await enabledButton("Discard permission choice", "[data-plugin-permission-panel]");
    await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Discard permission choice')");
    await session.button("Confirm permission change", '[data-modal-top="true"]');
    await session.poll("!document.querySelector('[data-plugin-permission-panel] > div.border-theme-warning')");
  }
  assert(writes.length === 19 && writes.slice(2).every(write => write.path === permissionPath && write.method === "PUT"), "Unexpected mutation in parent/retained-warning consumers");
  await close(); await invariant();
  assert(session.errors.length === 0, "Browser exceptions occurred during foundation consumers");
  removeObserver(); removeObserver = null;
  await closeFixture("writable-closure");
  session = null; server = null;

  // Separate actual public settings-lock fixture: no fake config/controller transition.
  const readonlyArtifacts = `${artifacts}/readonly-request`; await Deno.mkdir(readonlyArtifacts);
  vault = await Deno.makeTempDir({ prefix: "settings-foundations-readonly-vault-" });
  state = await Deno.makeTempDir({ prefix: "settings-foundations-readonly-state-" });
  await Deno.writeTextFile(`${vault}/NoteA.md`, "Seed content.\n");
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: "none", read_only_settings: true }));
  await Deno.mkdir(`${state}/plugins/foundation-guard`, { recursive: true });
  await Deno.writeTextFile(`${state}/plugins/foundation-guard/manifest.json`, JSON.stringify({ id: "foundation-guard", name: "Foundation request warning", runtime: { server: "service.js" }, capabilities: { network: true, imports: false } }));
  await Deno.writeTextFile(`${state}/plugins/foundation-guard/service.js`, "export async function activate(ctx){await ctx.permissions.requestAccess({kind:'network',hosts:true,reason:'Foundation read-only broad-access warning consumer'});}");
  server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "" }, logsDir: readonlyArtifacts });
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
  await Deno.writeTextFile(`${readonlyArtifacts}/ownership.json`, JSON.stringify({ vault, state, serverPid: server.pid, baseUrl: server.baseUrl, targetId: session.targetId, browserContextId: session.browserContextId }, null, 2), { createNew: true });
  const readonlyWrites = [];
  removeObserver = session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && !["GET", "HEAD"].includes(event.params.request.method)) readonlyWrites.push({ path: new URL(event.params.request.url).pathname, method: event.params.request.method });
  });
  await session.goto(`${server.baseUrl}/NoteA`);
  await session.poll("!!document.querySelector('#permission-request-title')");
  await session.button("Cancel", '[data-modal-top="true"]');
  await session.poll("!document.querySelector('#permission-request-title')");
  await open();
  for (const id of themeIds) {
    await theme(id);
    await session.button("Plugins", '[aria-label="Settings pages"]');
    await session.click('[data-permission-page="foundation-guard"]');
    await enabledButton("Review access request", "[data-plugin-permission-panel]");
    await session.poll("!!document.querySelector('#permission-request-title')");
    const broad = await warningObservation("[data-permission-request-choices] .text-theme-warning", "text");
    const readonly = await warningObservation('[data-modal-top="true"] section > p.text-theme-warning', "text");
    assert(readonly.text === "Read-only session: permission decisions are unavailable.", "Read-only warning describes the wrong state");
    assert(await inspect("(()=>{const inputs=[...document.querySelectorAll('[data-permission-request-choices] input')],decisions=[...document.querySelectorAll('[data-modal-top=true] button')].filter(el=>['Deny','Approve selected request'].includes(el.textContent.trim()));return inputs.length===2 && inputs.every(el=>el.disabled) && decisions.length===2 && decisions.every(el=>el.disabled);})()"), "Read-only request permits a decision or is missing its controls");
    await record(`request-warning-${id}`, { observations: [broad, readonly], mutations: readonlyWrites.length, screenshot: await screenshot(`request-warning-${id}`) });
    await session.button("Cancel", '[data-modal-top="true"]');
    await session.poll("!document.querySelector('#permission-request-title')");
  }
  assert(readonlyWrites.length === 0 && session.errors.length === 0, "Read-only warning consumers issued writes/browser exceptions");
  assert(await Deno.readTextFile(`${vault}/NoteA.md`) === "Seed content.\n", "Read-only warning consumer changed note disk");
} catch (error) { failure = error; console.error(`FAIL: ${error.message}`); }
finally {
  if (failure && session) await screenshot("failure").catch(() => {});
  const page = session && await inspect("({url:location.href,body:document.body.innerText})").catch(error => ({ error: error.message }));
  await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({ outcomes, failure: failure?.message, page, writes, pageErrors: session?.errors, events: session?.events, heldRequests: [...held] }, null, 2), { createNew: true });
  if (session) {
    for (const requestId of held) await session.send("Fetch.continueRequest", { requestId }).catch(() => {});
    if (held.size) await session.send("Fetch.disable").catch(() => {});
    removeObserver?.();
    await closeFixture("closure");
  }
  else if (server) await server.close();
}
if (failure) throw failure;
console.log(`SETTINGS FOUNDATIONS OK (${outcomes.length} consumer outcomes)`);
