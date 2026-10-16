// Feature-owned inventory/navigation consumers over the actual native application.
import { nativeSession } from "./native-cdp-session.mjs";
import { bootServer, parseArguments } from "./harness-helpers.mjs";
import { settleSettingsInventory } from "./settings-inventory-native.mjs";

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
const longLabel = "Unbroken".repeat(12);
const declaration = (id, label) => ({ id, label, renderer: { kind: "declarative-v1", version: 1 }, fields: [
  { key: "message", label: `${id} message`, type: "text", default: `${id} seed` },
  { key: "limit", label: `${id} limit`, type: "number", min: 1, max: 10, default: 5 },
] });
const multi = { id: "design-multi", name: "Multiple settings pages", settings: [declaration("one", "One"), declaration("words", "Several words for preferences"), declaration("long", longLabel)] };
const coreNamed = { id: "core", name: "Core-named plugin", settings: [declaration("identity", "Owner name is not page kind")] };
const disabled = { id: "design-disabled", name: "Disabled settings pages", settings: [declaration("disabled", "Disabled preferences")] };
const failed = { id: "design-failed", name: "Failed runtime valid pages", runtime: { server: "service.js" }, settings: [declaration("failed", "Failed runtime preferences")] };
const zero = { id: "design-zero", name: "No declared pages", entry: "main.js" };
let vault, state, server, session, failure, stopObserver, heldPolicy, holdNextPolicy = false, wireError;
const inspect = expression => session.evaluate(expression);
const settled = () => inspect("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
const item = id => `[data-plugin-inventory-id="${id}"]`;
const pageButton = (id, page) => `${item(id)} [data-settings-page-id="plugin:${id}:${page}"]`;
async function record(name, detail) {
  const row = { name, ...detail };
  await Deno.writeTextFile(`${artifacts}/${name}.json`, JSON.stringify(row, null, 2), { createNew: true });
  outcomes.push(row); console.log(`ok: ${name}`);
}
async function screenshot(name) {
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
  if (label === "Plugins") await session.poll("!!document.querySelector('[data-plugin-inventory]') || document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved settings')");
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
  await session.click(pageButton(id, page));
  await session.poll(`!!document.querySelector('#settings-field-message') && document.querySelector('#settings-field-message').value===${JSON.stringify(`${page} seed`)}`);
  await invariant();
}
async function manifest(value, files = {}) {
  const directory = `${state}/plugins/${value.id}`;
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(`${directory}/manifest.json`, JSON.stringify(value));
  for (const [name, content] of Object.entries(files)) await Deno.writeTextFile(`${directory}/${name}`, content);
}
async function inventoryPages(id, expectedPages) {
  const selector = item(id);
  const expectedIds = expectedPages.map(page => `plugin:${id}:${page.id}`);
  const actual = await inspect(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return el?[...el.querySelectorAll('[data-settings-page-id]')].map(b=>({id:b.dataset.settingsPageId,label:b.textContent.trim()})):null;})()`);
  assert(actual && JSON.stringify(actual.map(row => row.id)) === JSON.stringify(expectedIds), `inventory-pages contract ${id}: expected ${JSON.stringify(expectedIds)}, got ${JSON.stringify(actual)}`);
  assert(JSON.stringify(actual.map(row => row.label)) === JSON.stringify(expectedPages.map(page => page.label)), `${id}: full labels/order not preserved`);
  return expectedIds;
}
async function geometry(id, expectedPages, name) {
  const selector = item(id);
  const expectedIds = await inventoryPages(id, expectedPages);
  const hits = [];
  for (const target of [...expectedIds.map(page => `${selector} [data-settings-page-id="${page}"]`), `${selector} [data-settings-actions-end] button`]) {
    await inspect(`document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'center'})`); await settled();
    hits.push(await inspect(`(()=>{const el=document.querySelector(${JSON.stringify(target)}),r=el.getBoundingClientRect(),s=getComputedStyle(el);return {target:${JSON.stringify(target)},rect:r.toJSON(),hit:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),type:el.type,disabled:el.disabled,paddingX:parseFloat(s.paddingLeft),paddingY:parseFloat(s.paddingTop),fontWeight:s.fontWeight,background:s.backgroundColor,color:s.color,whiteSpace:s.whiteSpace};})()`));
  }
  const row = await inspect(`(()=>{
    const plugin=document.querySelector(${JSON.stringify(selector)}),box=plugin.querySelector('[data-settings-actions]');
    const rect=el=>el?.getBoundingClientRect().toJSON();
    const start=box.querySelector('[data-settings-actions-start]'),end=box.querySelector('[data-settings-actions-end]'),permissions=end.querySelector('button');
    const left=[...box.querySelectorAll('[data-settings-actions-start] button')].map(el=>({id:el.dataset.settingsPageId,rect:rect(el),labelRect:rect(el.querySelector('.icon-label-wrap > span')),lineHeight:parseFloat(getComputedStyle(el).lineHeight)}));
    const root=getComputedStyle(document.documentElement),dialog=box.closest('[role=dialog]');
    const pane=box.closest('.overflow-y-auto');
    const paneRect=pane.getBoundingClientRect(),paneStyle=getComputedStyle(pane);
    const overflowing=[...pane.querySelectorAll('button,span,p,div')].filter(el=>el.getBoundingClientRect().right>paneRect.right-parseFloat(paneStyle.paddingRight)+1).map(el=>({tag:el.tagName,class:el.className,text:el.textContent.trim(),rect:rect(el),whiteSpace:getComputedStyle(el).whiteSpace}));
    return {id:${JSON.stringify(id)},rect:rect(box),start:rect(start),end:rect(end),permissions:rect(permissions),left,gap:parseFloat(getComputedStyle(box).columnGap),rem:parseFloat(root.fontSize),overflow:dialog.scrollWidth-dialog.clientWidth,paneOverflow:pane.scrollWidth-pane.clientWidth,itemOverflow:plugin.scrollWidth-plugin.clientWidth,overflowing,fontsReady:document.fonts.status==='loaded',themeBrand:'rgb('+root.getPropertyValue('--theme-brand').trim().split(/\\s+/).join(', ')+')'};
  })()`);
  assert(row.fontsReady && row.overflow <= 1 && row.paneOverflow <= 1 && row.itemOverflow <= 1, `${name}/${id}: fonts/overflow contract ${JSON.stringify(row)}`);
  assert(row.gap >= row.rem - 0.5, `${name}/${id}: persistent one-rem gap missing`);
  assert(Math.abs(row.permissions.right - row.rect.right) <= 0.5, `${name}/${id}: Permissions not right aligned`);
  if (row.left.length) {
    assert(row.permissions.left - Math.max(...row.left.map(button => button.rect.right)) >= row.gap - 0.5, `${name}/${id}: action separation lost`);
    for (const button of row.left) assert(button.rect.left >= row.start.left - 0.5 && button.rect.right <= row.start.right + 0.5 && button.labelRect.right <= button.rect.right + 0.5, `${name}/${id}: left label/button escapes zone`);
  } else assert(!row.start, `${name}/${id}: invented empty left zone`);
  assert(row.permissions.left >= row.end.left - 0.5 && row.permissions.right <= row.end.right + 0.5, `${name}/${id}: Permissions escapes end zone`);
  for (const hit of hits) assert(hit.hit && !hit.disabled && hit.type === "button" && hit.paddingX === row.rem && hit.paddingY === row.rem * 0.625 && Number(hit.fontWeight) === 600 && hit.background === row.themeBrand && hit.color === "rgb(255, 255, 255)" && hit.whiteSpace !== "nowrap", `${name}/${id}: actual CTA/hit contract ${JSON.stringify(hit)}`);
  return { ...row, hits, screenshot: await screenshot(`${name}-${id}`) };
}
async function closeFixture() {
  try { await session?.close(); } finally { await server?.close(); }
  if (!session || !server) return;
  const targets = await fetch(`http://127.0.0.1:${Deno.env.get("CDP_PORT") ?? 9335}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  assert(!targets.some(target => target.id === session.targetId), "Owned design target still open");
  let closed = false;
  try { const health = await fetch(`${server.baseUrl}/_/api/health`, { signal: AbortSignal.timeout(5000) }); await health.body?.cancel(); }
  catch (error) { if (!(error instanceof TypeError)) throw error; closed = true; }
  assert(closed, "Owned design server still accepts connections");
  await Deno.writeTextFile(`${artifacts}/closure.json`, JSON.stringify({ targetClosed: true, serverClosed: true, filesRetained: true, targetId: session.targetId, pid: server.pid, failureCapturedBeforeClosure: !!failure }, null, 2), { createNew: true });
}
try {
  vault = await Deno.makeTempDir({ prefix: "settings-design-vault-" }); state = await Deno.makeTempDir({ prefix: "settings-design-state-" });
  await Deno.writeTextFile(`${vault}/NoteA.md`, "Seed content.\n");
  await Deno.writeTextFile(`${state}/config.json`, JSON.stringify({ auth_type: "none" }));
  await Deno.writeTextFile(`${state}/plugins.json`, JSON.stringify({ revision: 0, autoEnable: true, disabled: [disabled.id] }));
  await manifest(multi); await manifest(disabled); await manifest(coreNamed);
  await manifest(failed, { "service.js": "export function activate(){throw Error('Design deliberate runtime failure');}" });
  await manifest(zero, { "main.js": "export function getSelectors(){return [];}" });
  server = await bootServer(vault, state, { env: { GLOBNOTES_AUTH_TYPE: "" }, logsDir: artifacts, allowFailed: true });
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
  await Deno.writeTextFile(`${artifacts}/ownership.json`, JSON.stringify({ vault, state, pid: server.pid, baseUrl: server.baseUrl, targetId: session.targetId, browserContextId: session.browserContextId }, null, 2), { createNew: true });
  stopObserver = session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && !["GET", "HEAD"].includes(event.params.request.method)) writes.push({ path: new URL(event.params.request.url).pathname, method: event.params.request.method, body: event.params.request.postData });
    if (event.method !== "Fetch.requestPaused") return;
    const paused = event.params;
    if (holdNextPolicy && paused.request.method === "PUT") { holdNextPolicy = false; heldPolicy = paused; held.add(paused.requestId); }
    else session.send("Fetch.continueRequest", { requestId: paused.requestId }).catch(error => { wireError = error.message; });
  });
  await session.goto(`${server.baseUrl}/NoteA`); await session.poll("!!document.querySelector('.toast-viewer')");
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
  const catalog = await api("/_/api/plugin-host");
  const backup = catalog.plugins.find(plugin => plugin.id === "globnotes-backup");
  assert(backup?.pages.length === 1 && backup.pages[0].label === "Backups", "Shipped backup fixture absent");
  assert(catalog.plugins.find(plugin => plugin.id === failed.id)?.status === "failed", "Valid-page failed runtime fixture did not fail");
  assert(catalog.plugins.find(plugin => plugin.id === disabled.id)?.enabled === false, "Disabled fixture implicitly enabled");
  // Fail-first consumer deliberately observes the original missing inventory Backups action.
  const backupButtons = await inspect(`(()=>{const row=document.querySelector(${JSON.stringify(item(backup.id))});return row?[...row.querySelectorAll('button')].map(button=>button.textContent.trim()):[];})()`);
  assert(backupButtons.includes("Backups"), `inventory-pages contract: missing Backups launcher; actual buttons ${JSON.stringify(backupButtons)}`);
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
  await nav("Plugins"); await session.button("Permissions", item(multi.id));
  await session.poll("document.querySelector('[data-permission-review]')?.textContent.includes('Multiple settings pages')");
  await invariant(); await session.button("Close review", '[data-permission-review]'); await session.poll("!document.querySelector('[data-permission-review]')");
  assert(writes.length === beforeNavigation, "Page/Permissions navigation issued a mutation");
  await record("permissions-owner", { pluginId: multi.id, noMutation: true, editorTokenDraftRetained: true });
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
        const long = rows.find(row => row.id === multi.id).left.find(button => button.id.endsWith(':long'));
        assert(long.labelRect.height > long.lineHeight, "Narrow unbroken page label did not wrap");
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
  await session.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
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
  assert(await inspect("[...document.querySelectorAll('[aria-label=\"Settings pages\"] button')].some(button=>button.textContent.trim()==='One')"), "Removed dirty page lost its retained recovery navigation");
  await nav("Plugins"); await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved settings')");
  await session.button("Keep editing", '[data-modal-top=true]'); await session.poll("document.querySelector('#settings-field-limit')?.value===''");
  const recoveryShot = await screenshot("removed-page-recovery"); await invariant();
  await nav("Plugins"); await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved settings')");
  await session.button("Discard", '[data-modal-top=true]'); await session.poll(`!!document.querySelector(${JSON.stringify(pageButton(multi.id, "new"))}) && !document.querySelector(${JSON.stringify(pageButton(multi.id, "one"))})`);
  assert(!await inspect("[...document.querySelectorAll('[aria-label=\"Settings pages\"] button')].some(button=>button.textContent.trim()==='One')"), "Explicit discard did not retire removed recovery navigation");
  await launch(multi.id, "new"); await record("catalog-refresh-retained-recovery", { originalDraftKeptUntilExplicitDiscard: true, retainedSidebarReachable: true, refreshedCatalog, refreshedPageConsumed: true, screenshot: recoveryShot });
  await nav("Plugins");
  // Held inventory policy request must block the new injected navigation path.
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `*/_/api/plugin-host/${zero.id}/enabled`, requestStage: "Request" }] });
  holdNextPolicy = true; await session.button("Disabled", item(zero.id));
  for (const deadline = Date.now() + 15000; !heldPolicy;) { assert(Date.now() < deadline, "Owned policy request was not intercepted"); await new Promise(resolve => setTimeout(resolve, 50)); }
  await session.click(pageButton(multi.id, "new"));
  await session.poll("document.querySelector('[data-plugin-inventory]')?.textContent.includes('outcome is unknown')");
  assert(await inspect("!!document.querySelector('[data-plugin-inventory]') && !document.querySelector('#settings-field-message') && !document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')"), "Held inventory policy allowed page departure or unresolved-wire discard"); await invariant();
  const policyShot = await screenshot("held-policy-blocks-page");
  await session.send("Fetch.continueRequest", { requestId: heldPolicy.requestId }); held.delete(heldPolicy.requestId); heldPolicy = null;
  await session.send("Fetch.disable");
  await settleSettingsInventory(session, `document.querySelector(${JSON.stringify(item(zero.id))})?.textContent.includes('Enabled')`);
  await session.click(pageButton(multi.id, "new")); await session.poll("document.querySelector('#settings-field-message')?.value==='new seed'");
  await invariant(); await record("held-policy-navigation", { blockedWhileOwnedWireUnresolved: true, explicitSettlementThenPageConsumer: true, screenshot: policyShot });
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
