// Feature-owned inventory/navigation consumers over the actual native application.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { settleSettingsInventory } from "./settings-inventory-native.mjs";
import { formatVersion } from "../../../shared/version.ts";
import { assertSettingsHeaderRuleEdge, assertSettingsActionHierarchy, assertSettingRowAlignment, assertSettingRowErrors, assertSettingsVisualLanes } from "./settings-frame-native.mjs";
import { exerciseAppearanceDesign } from "./settings-appearance-native.mjs";
import { exerciseSettingsSurfaces } from './settings-surfaces-native.mjs';
import { exercisePrimitiveOwnership, assertSettingsActionZones } from './settings-primitives-native.mjs';

let options;
try { options = parseArguments(Deno.args); }
catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) {
  console.log("Usage: settings-design.mjs [--artifacts <fresh-directory>] [--help]");
  Deno.exit(0);
}
const artifacts = options.artifacts ?? await Deno.makeTempDir({ prefix: "settings-design-artifacts-" });
if (options.artifacts) await Deno.mkdir(artifacts, { mode: 0o700 });
const assert = (condition, message) => { if (!condition) throw Error(message); };
const outcomes = [], writes = [], held = new Set();
const declaredPages = new Map();
const longLabel = "Unbroken".repeat(12);
const declaration = (id, label) => ({ id, label, renderer: { kind: "declarative-v1", version: 1 }, fields: [
  { key: "message", label: `${id} message`, type: "text", default: `${id} seed` },
  { key: "limit", label: `${id} limit`, type: "number", min: 1, max: 10, default: 5 },
] });
const multi = { id: "design-multi", name: "Multiple settings pages", runtime:{server:"service.js",client:'browser.js'}, capabilities:{network:['attention.example:443']}, settings: [declaration("one", "One"), declaration("words", "Several words for preferences"), declaration("long", longLabel)] };
const attentionPlugin={id:'design-attention',name:'Waiting decisions',runtime:{server:'service.js'},capabilities:{network:['attention.example:443'],imports:false}};
const coreNamed = { id: "core", name: "Core-named plugin", settings: [declaration("identity", "Owner name is not page kind")] };
const disabled = { id: "design-disabled", name: "Disabled settings pages", settings: [declaration("disabled", "Disabled preferences")] };
const failed = { id: "design-failed", name: "Failed runtime valid pages", runtime: { server: "service.js" }, settings: [declaration("failed", "Failed runtime preferences")] };
const zero = { id: "design-zero", name: "No declared pages", entry: "main.js" };
let vault, state, server, session, failure, stopObserver, heldPolicy, holdNextPolicy = false, wireError;
const inspect = expression => session.evaluate(expression);
const settled = () => inspect("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
const cdpPort = Number(Deno.env.get("CDP_PORT"));
assert(Number.isInteger(cdpPort) && cdpPort > 0, "CDP_PORT must name the run-owned browser");
const item = id => `[data-plugin-inventory-id="${id}"]`;
const pageButton = (id, page) => `${item(id)} [data-settings-page-id="plugin:${id}:${page}"]`;
async function record(name, detail) {
  const row = { name, ...detail };
  await Deno.writeTextFile(`${artifacts}/${name}.json`, JSON.stringify(row, null, 2), { createNew: true });
  outcomes.push(row); console.log(`ok: ${name}`);
}
async function screenshot(name) {
  await settled();
  const edge = await assertSettingsHeaderRuleEdge(session);
  await assertSettingsActionHierarchy(session);
  await assertSettingsActionZones(session);
  await assertSettingRowAlignment(session);
  await assertSettingRowErrors(session);
  await assertSettingsVisualLanes(session);
  await Deno.writeTextFile(`${artifacts}/${name}.header-edge.json`,JSON.stringify(edge,null,2),{createNew:true});
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  const path = `${artifacts}/${name}.png`;
  await Deno.writeFile(path, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { createNew: true });
  return path;
}
async function api(path) {
  const response = await fetch(`${server.baseUrl}${path}`, { signal: AbortSignal.timeout(5000) });
  assert(response.ok, `Authoritative read rejected ${path}: ${response.status}`); return response.json();
}
async function replace(selector, value) {
  await session.click(selector); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  if (value) await session.type(value); else await session.key("Backspace", { windowsVirtualKeyCode: 8 });
}
async function nav(label) {
  await session.button(label, '[aria-label="Settings pages"]');
  if (label === "Plugins") await session.poll("!!document.querySelector('[data-plugin-inventory]') || document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')");
}
async function invariant() {
  const observation = await inspect("({sameEditor:document.querySelector('.cm-content')===window.__designEditor,draft:document.querySelector('.cm-content')?.textContent,expectedDraft:window.__designDraft,sameToken:sessionStorage.getItem('token')===window.__designToken,url:location.href,expectedUrl:window.__designUrl})");
  assert(observation.sameEditor && observation.draft === observation.expectedDraft && observation.sameToken && observation.url === observation.expectedUrl, `Inventory interaction lost editor/token/URL/newer note draft: ${JSON.stringify(observation)}`);
  assert(await Deno.readTextFile(`${vault}/NoteA.md`) === "Seed content.\n", "Inventory navigation wrote the unsaved note");
  assert(!wireError, wireError);
}
async function open() {
  if (await inspect("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
  await session.click('[aria-label="Settings"]'); await session.poll("!!document.querySelector('#settings-modal-title')");
}
async function launch(id, page) {
  await session.click(`${item(id)} [data-settings-page-id]`);
  await session.poll("!!document.querySelector('#settings-field-message') && !document.querySelector('#settings-field-message').readOnly");
  const declarations = declaredPages.get(id) ?? [];
  const tabs = await inspect("[...document.querySelectorAll('[role=tab]')].map(el=>({id:el.dataset.settingsTabId,label:el.textContent.trim()}))");
  const expectedTabs = declarations.length >= 2 ? declarations.map(page => ({id:`plugin:${id}:${page.id}`,label:page.label})) : [];
  assert(JSON.stringify(tabs) === JSON.stringify(expectedTabs), `${id}: complete page IDs, labels and registry order not preserved in tabs`);
  const tab = `[data-settings-tab-id="plugin:${id}:${page}"]`;
  if (await inspect(`!!document.querySelector(${JSON.stringify(tab)})`)) await session.click(tab);
  await session.poll(`!!document.querySelector('#settings-field-message') && !document.querySelector('#settings-field-message').readOnly && document.querySelector('#settings-field-message').value===${JSON.stringify(`${page} seed`)}`);
  await invariant();
}
async function manifest(value, files = {}) {
  declaredPages.set(value.id, value.settings ?? []);
  const directory = `${state}/plugins/${value.id}`;
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(`${directory}/manifest.json`, JSON.stringify(value));
  for (const [name, content] of Object.entries(files)) await Deno.writeTextFile(`${directory}/${name}`, content);
}
async function inventoryPages(id, expectedPages) {
  const selector = item(id);
  const expectedIds = expectedPages.map(page => `plugin:${id}:${page.id}`);
  const actual = await inspect(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return el?[...el.querySelectorAll('[data-settings-page-id]')].map(b=>({id:b.dataset.settingsPageId,label:b.textContent.trim()})):null;})()`);
  const launchIds = expectedIds.slice(0,1);
  assert(actual && JSON.stringify(actual.map(row => row.id)) === JSON.stringify(launchIds), `inventory-pages contract ${id}: expected first-page launcher ${JSON.stringify(launchIds)}, got ${JSON.stringify(actual)}`);
  assert(actual.every(row => row.label === "Open settings"), `${id}: shared launcher caption lost`);
  const entries = await inspect(`document.querySelectorAll(${JSON.stringify(`[data-settings-nav-id="plugin:${id}"]`)}).length`);
  assert(entries === (expectedIds.length ? 1 : 0), `${id}: expected one plugin navigation entry only when it declares pages`);
  return expectedIds;
}
async function geometry(id, expectedPages, name) {
  const selector = item(id);
  const expectedIds = await inventoryPages(id, expectedPages);
  const hits = [];
  for (const target of [...expectedIds.slice(0,1).map(page => `${selector} [data-settings-page-id="${page}"]`), `${selector} .plugin-row-actions [role=switch]`]) {
    await inspect(`document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'center'})`); await settled();
    hits.push(await inspect(`(()=>{const el=document.querySelector(${JSON.stringify(target)}),r=el.getBoundingClientRect(),s=getComputedStyle(el);return {target:${JSON.stringify(target)},rect:r.toJSON(),hit:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),type:el.type,disabled:el.disabled,paddingX:parseFloat(s.paddingLeft),paddingY:parseFloat(s.paddingTop),fontWeight:s.fontWeight,background:s.backgroundColor,color:s.color,whiteSpace:s.whiteSpace};})()`));
  }
  const row = await inspect(`(()=>{
    const plugin=document.querySelector(${JSON.stringify(selector)}),pane=plugin.closest('[data-settings-content]'),dialog=plugin.closest('[role=dialog]');
    const first=plugin.querySelector('.plugin-row-name').getClientRects()[0],toggle=plugin.querySelector('.plugin-row-actions [role=switch]').getBoundingClientRect();
    const nav=document.querySelector('[aria-label="Settings pages"]');
    return {id:${JSON.stringify(id)},nameLineCenter:(first.top+first.bottom)/2,toggleCenter:toggle.y+toggle.height/2,
      overflow:dialog.scrollWidth-dialog.clientWidth,paneOverflow:pane.scrollWidth-pane.clientWidth,
      itemOverflow:plugin.scrollWidth-plugin.clientWidth,navOverflow:nav.scrollWidth-nav.clientWidth,
      fontsReady:document.fonts.status==='loaded',current:nav.querySelector('[aria-current=page]')?.dataset.settingsNavId};
  })()`);
  assert(row.fontsReady && row.overflow <= 1 && row.paneOverflow <= 1 && row.itemOverflow <= 1 && row.navOverflow <= 1, `${name}/${id}: fonts/overflow contract ${JSON.stringify(row)}`);
  assert(Math.abs(row.nameLineCenter-row.toggleCenter)<=.75,`${name}/${id}: toggle left the first name line ${JSON.stringify(row)}`);
  assert(row.current==='core:plugins',`${name}/${id}: current-page navigation missing`);
  for (const hit of hits) assert(hit.hit && !hit.disabled && hit.type === "button", `${name}/${id}: actual action/hit contract ${JSON.stringify(hit)}`);
  return { ...row, hits, screenshot: await screenshot(`${name}-${id}`) };
}
async function closeFixture() {
  try { await session?.close(); } finally { await server?.close(); }
  if (!session || !server) return;
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  assert(!targets.some(target => target.id === session.targetId), "Owned design target still open");
  let closed = false;
  try { const health = await fetch(`${server.baseUrl}/_/api/health`, { signal: AbortSignal.timeout(5000) }); await health.body?.cancel(); }
  catch (error) { if (!(error instanceof TypeError)) throw error; closed = true; }
  assert(closed, "Owned design server still accepts connections");
  await Deno.writeTextFile(`${artifacts}/closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true, filesRetained: true, targetId: session.targetId, pid: server.pid, failureCapturedBeforeClosure: !!failure }, null, 2), { createNew: true });
}
try {
  await record('shared-primitive-ownership',await exercisePrimitiveOwnership({port:cdpPort,directory:`${artifacts}/primitives`}));
  await record('every-page-dialog-matrix',await exerciseSettingsSurfaces({port:cdpPort,directory:`${artifacts}/surfaces`}));
  vault = await Deno.makeTempDir({ prefix: "settings-design-vault-" }); state = await Deno.makeTempDir({ prefix: "settings-design-state-" });
  await Deno.writeTextFile(`${vault}/NoteA.md`, "Seed content.\n");
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: "none" }));
  await Deno.writeTextFile(`${state}/plugins.json`, JSON.stringify({ revision: 0, autoEnable: true, disabled: [disabled.id] }));
  await manifest(multi,{"service.js":"export function activate(){}",
    'browser.js':"export function activate(ctx){const button=document.createElement('button');button.type='button';button.dataset.legacyPermissions='';button.textContent='Open legacy permissions';button.style.cssText='position:fixed;top:16px;right:16px;z-index:25';button.onclick=()=>ctx.actions.dispatch('app:open-settings',{page:'core:plugin-permissions:design-multi'});document.body.append(button);ctx.register(()=>button.remove());}"}); await manifest(disabled); await manifest(coreNamed);
  // This owner stays stable while the separate multi-page owner is deliberately
  // replaced/retired by the recovery case below.
  await manifest(attentionPlugin,{'service.js':"export function activate(ctx){ctx.commands.register({id:'attention',label:'Queue waiting decision',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['attention.example:443'],reason:'Settings waiting-decision consumer'}));}"});
  await manifest(failed, { "service.js": "export function activate(){throw Error('Design deliberate runtime failure');}" });
  await manifest(zero, { "main.js": "export function getSelectors(){return [];}" });
  server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "", TMPDIR:Deno.env.get("TMPDIR") }, logsDir: artifacts, allowFailed: true });
  session = await nativeSession({ port:cdpPort });
  await Deno.writeTextFile(`${artifacts}/ownership.json`, JSON.stringify({ vault, state, pid: server.pid, baseUrl: server.baseUrl, targetId: session.targetId, browserContextId: session.browserContextId }, null, 2), { createNew: true });
  stopObserver = session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && !["GET", "HEAD"].includes(event.params.request.method)) writes.push({ path: new URL(event.params.request.url).pathname, method: event.params.request.method, body: event.params.request.postData });
    if (event.method !== "Fetch.requestPaused") return;
    const paused = event.params;
    if (holdNextPolicy && paused.request.method === "PUT") { holdNextPolicy = false; heldPolicy = paused; held.add(paused.requestId); }
    else session.send("Fetch.continueRequest", { requestId: paused.requestId }).catch(error => { wireError = error.message; });
  });
  await session.goto(`${server.baseUrl}/NoteA`); await session.poll("!!document.querySelector('.toast-viewer')");
  await open();
  assert(await inspect("!document.querySelector('[data-settings-attention]')"),'Empty attention section must be absent');
  await record('appearance-radio-palettes-persistence',await exerciseAppearanceDesign(session));
  await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')");
  if(await inspect("!!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width"))await session.click('[title="Close sidebar"]');
  await session.poll("!document.querySelector('[title=\"Close sidebar\"]')?.getBoundingClientRect().width");
  await session.button("Edit", ".content-column"); await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  await session.click(".cm-content"); await session.type("Design newer unsaved note\n");
  await session.poll("document.querySelector('.cm-content').textContent.includes('Design newer unsaved note')");
  // The source editor's selection owner debounces URL publication. Establish
  // an observed native caret/fragment before pinning the navigation invariant.
  await session.key("Home", { modifiers: 2, windowsVirtualKeyCode: 36 });
  await session.poll("location.hash==='#source:L1'");
  await inspect("window.__designEditor=document.querySelector('.cm-content');window.__designDraft=window.__designEditor.textContent;window.__designToken=sessionStorage.getItem('token');window.__designUrl=location.href;true");
  await open(); await nav("Plugins");
  await record("header-rule-edge",await assertSettingsHeaderRuleEdge(session));
  const catalog = await api("/_/api/plugin-host");
  const backup = catalog.plugins.find(plugin => plugin.id === "globnotes-backup");
  assert(backup?.pages.length === 1 && backup.pages[0].label === "Backups", "Shipped backup fixture absent");
  assert(catalog.plugins.find(plugin => plugin.id === failed.id)?.status === "failed", "Valid-page failed runtime fixture did not fail");
  assert(catalog.plugins.find(plugin => plugin.id === disabled.id)?.enabled === false, "Disabled fixture implicitly enabled");
  // Fail-first consumer deliberately observes the original missing inventory Backups action.
  const backupButtons = await inspect(`(()=>{const row=document.querySelector(${JSON.stringify(item(backup.id))});return row?[...row.querySelectorAll('button')].map(button=>button.textContent.trim()):[];})()`);
  assert(backupButtons.includes("Open settings"), `inventory-pages contract: missing shipped Backups launcher; actual buttons ${JSON.stringify(backupButtons)}`);
  for (const [id, pages] of [[backup.id, backup.pages], [multi.id, multi.settings], [coreNamed.id, coreNamed.settings], [disabled.id, disabled.settings], [failed.id, failed.settings], [zero.id, []]]) await inventoryPages(id, pages);
  await session.click(pageButton(backup.id, "backup"));
  await session.poll("!!document.querySelector('#settings-field-retention') && !!document.querySelector('#settings-field-basePath') && !document.querySelector('#settings-field-retention').disabled");
  assert(await inspect("document.querySelector('[data-modal-top=true]').textContent.includes('Retained versions') && document.querySelector('[data-modal-top=true]').textContent.includes('Backup base path')"), "Inventory Backups did not open shipped fields");
  await invariant(); assert(writes.length === 0, "Backups navigation issued a mutation");
  const initialBackup = await api("/_/api/plugin-host/globnotes-backup/settings/backup");
  await session.click("#settings-field-retention");
  await session.poll("document.activeElement===document.querySelector('#settings-field-retention')");
  await session.key("Home", { windowsVirtualKeyCode: 36 });
  for (let count = 1; count < 3; count++) await session.key("ArrowRight", { windowsVirtualKeyCode: 39 });
  await session.poll("document.querySelector('#settings-field-retention').value==='3'");
  await session.key("Enter", { windowsVirtualKeyCode: 13 });
  await session.poll("fetch('/_/api/plugin-host/globnotes-backup/settings/backup').then(r=>r.json()).then(d=>d.values.retention===3)");
  await nav("Plugins"); await session.click(pageButton(backup.id, "backup"));
  await session.poll("document.querySelector('#settings-field-retention')?.value==='3'");
  const persistedBackup = await api("/_/api/plugin-host/globnotes-backup/settings/backup");
  const backupDisk = JSON.parse(await Deno.readTextFile(`${state}/plugin-data/globnotes-backup/settings.json`));
  assert(persistedBackup.revision === initialBackup.revision + 1 && backupDisk.values.backup.retention === 3 && writes.length === 1 && writes[0].path.endsWith('/globnotes-backup/settings/backup'), "Backup retention did not persist exactly once through API/disk/reopened consumer");
  await record("backups-persistence", { initialBackup, persistedBackup, backupDisk, reopened: 3, screenshot: await screenshot("backups-reopened"), writes: [...writes] });
  const beforeNavigation = writes.length;
  for (const page of multi.settings) { await nav("Plugins"); await launch(multi.id, page.id); await record(`page-${page.id}`, { id: `plugin:${multi.id}:${page.id}`, fieldsConsumed: true, screenshot: await screenshot(`page-${page.id}`) }); }
  await nav("Plugins"); await launch(coreNamed.id, "identity");
  await record("core-named-plugin-page", { id: "plugin:core:identity", fieldsConsumed: true, screenshot: await screenshot("core-named-plugin-page") });
  await nav("Plugins"); await launch(failed.id, "failed");
  await record("failed-valid-page", { status: "failed", pageVisible: true, screenshot: await screenshot("failed-valid-page") });
  await nav("Plugins"); await session.click(pageButton(disabled.id, "disabled"));
  await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('This page is unavailable') && document.querySelector('#settings-field-message')?.readOnly");
  await invariant(); assert((await api("/_/api/plugin-host")).plugins.find(plugin => plugin.id === disabled.id).enabled === false, "Opening disabled page enabled its owner");
  await record("disabled-valid-page", { disabled: true, unavailable: true, screenshot: await screenshot("disabled-valid-page") });
  await nav("Plugins"); await session.click(`${item(multi.id)} button[aria-expanded]`);
  await session.poll(`!!document.querySelector('${item(multi.id)} [data-plugin-permission-panel] [role=switch]') && document.querySelector('${item(multi.id)}').textContent.includes(${JSON.stringify(multi.name)})`);
  await invariant(); await session.click(`${item(multi.id)} button[aria-expanded]`); await session.poll(`!document.querySelector('${item(multi.id)} [data-plugin-permission-panel]')`);
  assert(writes.length === beforeNavigation, "Page/Permissions navigation issued a mutation");
  await record("permissions-owner", { pluginId: multi.id, noMutation: true, editorTokenDraftRetained: true });
  await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')");
  await session.click('[data-legacy-permissions]'); await session.poll("document.querySelector('[data-settings-content]')?.dataset.settingsCurrentPage==='core:plugins' && document.querySelector('[data-plugin-inventory-id=design-multi] button[aria-expanded]')?.getAttribute('aria-expanded')==='true'");
  await invariant(); assert(writes.length===beforeNavigation,'Legacy deep link caused a write');
  await record('legacy-permission-deep-link',{sdkDispatch:true,page:'core:plugins',expanded:multi.id,noWrites:true});
  await session.click(`${item(multi.id)} button[aria-expanded]`);
  await launch(multi.id,'one'); await session.button('Manage in Plugins');
  await session.poll("document.querySelector('[data-settings-content]')?.dataset.settingsCurrentPage==='core:plugins' && document.querySelector('[data-plugin-inventory-id=design-multi] button[aria-expanded]')?.getAttribute('aria-expanded')==='true'");
  await invariant(); assert(writes.length===beforeNavigation,'Manage in Plugins caused a write');
  await record('manage-in-plugins',{expanded:multi.id,noWrites:true});
  await session.click(`${item(multi.id)} button[aria-expanded]`);
  const inventoryCases = [[backup.id, backup.pages], [multi.id, multi.settings], [coreNamed.id, coreNamed.settings], [disabled.id, disabled.settings], [failed.id, failed.settings], [zero.id, []]];
  for (const viewport of [{ width: 320, height: 640 }, { width: 360, height: 640 }, { width: 768, height: 900 }, { width: 1280, height: 900 }]) {
    for (const dpr of [1, 2]) for (const mode of ["light", "dark"]) {
      const name = `inventory-${viewport.width}-dpr-${dpr}-${mode}`;
      await session.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: dpr, mobile: false });
      await nav("Appearance"); await session.click(`[data-theme-id="globnotes-${mode}"]`);
      await session.poll(`localStorage.getItem('globnotes-theme')==='globnotes-${mode}'`); await settled(); await nav("Plugins");
      const rows = [];
      for (const [id, pages] of inventoryCases) rows.push(await geometry(id, pages, name));
      await Deno.writeTextFile(`${artifacts}/${name}.geometry.json`, JSON.stringify({ viewport, dpr, mode, rows }, null, 2), { createNew: true });
      if (viewport.width === 320) {
        await launch(multi.id,"long");
        const tab = await inspect(`(()=>{const el=document.querySelector('[data-settings-tab-id="plugin:${multi.id}:long"]'),pane=el.closest('[data-settings-content]');return {height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight),overflow:pane.scrollWidth-pane.clientWidth};})()`);
        assert(tab.height>tab.lineHeight*2 && tab.overflow<=1,"Narrow unbroken page label did not wrap within its tab/page owner");
        await nav("Plugins");
      }
      const focusSelector = pageButton(multi.id, "one");
      let focused = false;
      for (let count = 0; count < 100; count++) { await session.key("Tab", { windowsVirtualKeyCode: 9 }); if (await inspect(`document.activeElement===document.querySelector(${JSON.stringify(focusSelector)})`)) { focused = true; break; } }
      assert(focused, "Keyboard cannot reach inventory page action");
      const focus = await inspect("(()=>{const s=getComputedStyle(document.activeElement);return {visible:document.activeElement.matches(':focus-visible'),style:s.outlineStyle,width:parseFloat(s.outlineWidth),color:s.outlineColor};})()");
      assert(focus.visible && focus.style === "solid" && focus.width >= 2, "Inventory page action has no visible keyboard focus");
      for (const type of ["keyDown", "keyUp"]) await session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      await session.poll("document.querySelector('#settings-field-message')?.value==='one seed'");
      await nav("Plugins"); await invariant();
      assert(writes.length === beforeNavigation, "Inventory matrix navigation issued mutations");
      await record(name, { viewport, dpr, mode, rows, focus, keyboardOpenedPage: true, navigationMutations: 0 });
    }
  }
  await session.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  await nav("Appearance"); await session.click('[data-theme-id="globnotes-light"]'); await nav("Plugins");
  const textSize = await inspect("(()=>{const root=document.documentElement,base=parseFloat(getComputedStyle(root).fontSize);root.style.fontSize=(base*2)+'px';return {base,scaled:parseFloat(getComputedStyle(root).fontSize)};})()");
  await settled(); const enlargedRows = [];
  for (const [id, pages] of inventoryCases) enlargedRows.push(await geometry(id, pages, "inventory-200-text"));
  assert(textSize.scaled === textSize.base * 2, "200% text size was not actually applied");
  await record("inventory-200-text", { textSize, rows: enlargedRows });
  await inspect("document.documentElement.style.removeProperty('font-size');true");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // Actual manifest/catalog replacement while an invalid raw field is retained.
  await nav("Plugins"); await launch(multi.id, "one"); await replace("#settings-field-limit", "");
  await manifest({ ...multi, settings: [declaration("new", "Refreshed declaration"), ...multi.settings.slice(1)] });
  // An explicit supported policy operation publishes the actual refreshed catalog.
  const currentPolicy = await api("/_/api/plugin-host");
  const refreshResponse = await fetch(`${server.baseUrl}/_/api/plugin-host/${zero.id}/enabled`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false, revision: currentPolicy.policy.revision, signature: currentPolicy.policy.signature }), signal: AbortSignal.timeout(5000) });
  assert(refreshResponse.ok, "Owned refresh policy operation rejected"); await refreshResponse.body?.cancel();
  const refreshedCatalog = await api("/_/api/plugin-host");
  assert(refreshedCatalog.plugins.find(plugin => plugin.id === multi.id)?.pages[0]?.id === "new", "Actual server catalog did not publish replacement definition");
  await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('This page is unavailable') && document.querySelector('#settings-field-limit')?.value===''");
  assert(await inspect("[...document.querySelectorAll('[role=tab]')].some(button=>button.textContent.trim()==='One')"), "Removed dirty page lost its retained recovery navigation");
  await nav("Plugins"); await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')");
  await session.button("Keep editing", '[data-modal-top=true]'); await session.poll("document.querySelector('#settings-field-limit')?.value===''");
  const recoveryShot = await screenshot("removed-page-recovery"); await invariant();
  await nav("Plugins"); await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')");
  await session.button("Discard", '[data-modal-top=true]'); await session.poll(`!!document.querySelector(${JSON.stringify(pageButton(multi.id, "new"))}) && !document.querySelector(${JSON.stringify(pageButton(multi.id, "one"))})`);
  assert(!await inspect("[...document.querySelectorAll('[role=tab]')].some(button=>button.textContent.trim()==='One')"), "Explicit discard did not retire removed recovery navigation");
  await launch(multi.id, "new"); await record("catalog-refresh-retained-recovery", { originalDraftKeptUntilExplicitDiscard: true, retainedSidebarReachable: true, refreshedCatalog, refreshedPageConsumed: true, screenshot: recoveryShot });
  await nav("Plugins");
  // Held inventory policy request must block the new injected navigation path.
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `*/_/api/plugin-host/${zero.id}/enabled`, requestStage: "Request" }] });
  holdNextPolicy = true; await session.click(`${item(zero.id)} .plugin-row-actions [role=switch]`);
  for (const deadline = Date.now() + 15000; !heldPolicy;) { assert(Date.now() < deadline, "Owned policy request was not intercepted"); await new Promise(resolve => setTimeout(resolve, 50)); }
  await session.click(pageButton(multi.id, "new"));
  await session.poll("document.querySelector('[data-plugin-inventory]')?.textContent.includes('outcome is unknown')");
  assert(await inspect("!!document.querySelector('[data-plugin-inventory]') && !document.querySelector('#settings-field-message') && !document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved changes')"), "Held inventory policy allowed page departure or unresolved-wire discard"); await invariant();
  const policyShot = await screenshot("held-policy-blocks-page");
  await session.send("Fetch.continueRequest", { requestId: heldPolicy.requestId }); held.delete(heldPolicy.requestId); heldPolicy = null;
  await session.send("Fetch.disable");
  await settleSettingsInventory(session, `document.querySelector(${JSON.stringify(`${item(zero.id)} .plugin-row-actions [role=switch]`)})?.getAttribute('aria-checked')==='true'`);
  await session.click(pageButton(multi.id, "new")); await session.poll("document.querySelector('#settings-field-message')?.value==='new seed'");
  await invariant(); await record("held-policy-navigation", { blockedWhileOwnedWireUnresolved: true, explicitSettlementThenPageConsumer: true, screenshot: policyShot });
  // Header version: the server's own config, beside (not inside) the dialog title, clear of Close.
  const appConfig = await api("/_/api/config"), expectedVersion = formatVersion(appConfig);
  assert(typeof appConfig.version === "string" && expectedVersion !== "", `header-version: config has no version ${JSON.stringify({ version: appConfig.version, revision: appConfig.revision })}`);
  const headerCases = [];
  for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 640 }]) {
    await session.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false }); await settled();
    const header = await inspect(`(()=>{const title=document.querySelector('#settings-modal-title'),label=document.querySelector('[data-app-version]'),close=document.querySelector('[aria-label="Close settings"]');const rect=el=>el?el.getBoundingClientRect().toJSON():null;return {text:label?label.textContent.trim():null,insideTitle:!!label&&title.contains(label),title:rect(title),label:rect(label),close:rect(close)};})()`);
    assert(header.text === expectedVersion, `header-version ${viewport.width}: expected ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(header.text)}`);
    assert(!header.insideTitle, `header-version ${viewport.width}: version is inside the title heading`);
    const overlap = header.label.right > header.close.left && header.label.left < header.close.right && header.label.bottom > header.close.top && header.label.top < header.close.bottom;
    assert(!overlap, `header-version ${viewport.width}: version overlaps Close ${JSON.stringify(header)}`);
    headerCases.push({ viewport, ...header, screenshot: await screenshot(`header-version-${viewport.width}`) });
  }
  await record("header-version", { config: { version: appConfig.version, revision: appConfig.revision }, expected: expectedVersion, cases: headerCases });
  await session.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const requestResponse=await fetch(`${server.baseUrl}/_/api/plugin-host/${attentionPlugin.id}/commands/attention`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const requestReceipt=await requestResponse.json();
  assert(requestResponse.ok,`Attention fixture command rejected ${requestResponse.status}: ${JSON.stringify(requestReceipt)}`);
  await session.poll("!!document.querySelector('#permission-request-title')"); await session.button('Review later','[data-modal-top=true]');
  await session.poll("!document.querySelector('#permission-request-title') && document.querySelectorAll('[data-settings-attention] button').length===1");
  await nav('Plugins');
  assert(await inspect(`document.querySelector('${item(attentionPlugin.id)}').textContent.includes('1 access request')`),'Plugins count diverged from attention items');
  await session.click('[data-settings-nav-id="plugin:globnotes-backup"]'); await session.poll("!!document.querySelector('#settings-field-retention')");
  const beforeAttention=await inspect("({page:document.querySelector('[data-settings-content]').dataset.settingsCurrentPage,url:location.href,field:document.querySelector('#settings-field-retention').value})");
  assert(await inspect("document.querySelector('[data-settings-attention] h3').textContent==='Needs attention (1)' && !document.querySelector('[data-settings-attention] button').hasAttribute('aria-current')"),'Attention count/button semantics failed');
  await session.click('[data-settings-attention] button'); await session.poll("!!document.querySelector('#permission-request-title')");
  const afterAttention=await inspect("({page:document.querySelector('[data-settings-content]').dataset.settingsCurrentPage,url:location.href,field:document.querySelector('#settings-field-retention').value})");
  assert(JSON.stringify(beforeAttention)===JSON.stringify(afterAttention),'Attention changed page, URL or field'); await invariant();
  await assertSettingsActionHierarchy(session);
  await session.button('Deny','[data-modal-top=true]'); await session.poll("!document.querySelector('#permission-request-title') && !document.querySelector('[data-settings-attention]')");
  await record('attention-layer-no-navigation',{before:beforeAttention,after:afterAttention,countMatched:true,retractedAfterDecision:true});
  assert(session.errors.length === 0, "Browser exceptions during inventory/navigation consumers");
} catch (error) { failure = error; console.error(`FAIL: ${error.message}`); }
finally {
  if (failure && session) await screenshot("failure").catch(() => {});
  const page = session && await inspect("({url:location.href,body:document.body.innerText})").catch(error => ({ error: error.message }));
  if (session) {
    for (const requestId of held) { await session.send("Fetch.continueRequest", { requestId }); held.delete(requestId); }
    await session.send("Fetch.disable"); stopObserver?.();
  }
  await Deno.writeTextFile(`${artifacts}/diagnostics.json`, JSON.stringify({ outcomes, failure: failure?.message, page, writes, pageErrors: session?.errors, events: session?.events, heldRequests: [...held], wireError }, null, 2), { createNew: true });
  await closeFixture();
}
if (failure) throw failure;
console.log(`SETTINGS DESIGN OK (${outcomes.length} inventory/navigation outcomes)`);
