// Callback-injected actual Settings/permission/local-preference consumers.
export async function exerciseLockedControls({ session, api, baseUrl, state, vault, openAccess, capture }) {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const id = "access-workflow", settingsRoute = `plugin-host/${id}/settings/preferences`;
  const seeded = await api(settingsRoute, "PUT", { values: { message: "locked retained settings consumer", limit: 5 }, revision: 0 });
  assert(seeded.status === 200, "Locked-controls settings seed rejected");
  const requested = (await api(`plugin-host/${id}/permissions`)).body;
  const remembered = requested.requestedNetwork.find(scope => scope.authority === "127.0.0.1:9");
  assert(remembered && requested.requestedNetwork.length === 2, "Expected two inert requested hosts");
  const permissionSeed = await api(`plugin-host/${id}/permissions`, "PUT", { revision: requested.revision, signature: requested.signature, requestSourceKey: requested.requestSourceKey, requestSourceRevision: requested.requestSourceRevision, allowNetwork: false, approvedNetwork: [remembered], approvedImports: [] });
  assert(permissionSeed.status === 200 && !permissionSeed.body.view.allowNetwork, "Remembered master-off approval seed failed");
  const owner = (await api(`plugin-host/${id}/commands/report`, "POST", {})).body.result.owner;
  const beforeCatalog = (await api("plugin-host")).body;
  assert(beforeCatalog.policy.autoEnableSource === "vault" && beforeCatalog.policy.effectiveAutoEnable === false, "Auto-enable fixture is unexpectedly environment-pinned");
  await openAccess(); await session.click("#setup-read-only-settings"); await session.click("#setup-ack"); await session.button("Save access settings");
  await session.poll("!document.querySelector('#setup-title')");
  assert((await api("config")).body.settingsWritable === false, "Native controls fixture did not lock settings");
  const files = ["config.json", "plugins.json", `plugin-data/${id}/settings.json`];
  const retained = Object.fromEntries(await Promise.all(files.map(async file => [file, await Deno.readTextFile(`${state}/${file}`)])));
  const writes = [];
  const stop = session.page.onEvent(event => {
    if (event.method !== "Network.requestWillBeSent") return;
    const request = event.params.request, path = new URL(request.url).pathname;
    if (request.method !== "GET" && /^\/_\/api\/(brand(?:\/|$)|access(?:\/|$)|setup(?:\/|$)|plugin-host\/(policy(?:\/|$)|[^/]+\/(enabled|settings|permissions|permission-requests)(?:\/|$)))/.test(path)) writes.push({ path, method: request.method });
  });
  async function open() {
    if (await session.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
    await session.click('[aria-label="Settings"]'); await session.poll("!!document.querySelector('#settings-modal-title')");
  }
  async function close() {
    await session.click('[aria-label="Close settings"]'); await session.poll("!document.querySelector('#settings-modal-title')");
  }
  async function disabledButton(text, scope) {
    const expression = `(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(button=>button.textContent.trim()===${JSON.stringify(text)});return !!button&&button.disabled;})()`;
    assert(await session.evaluate(expression), `${text}: actual mutation control is not disabled`);
    await session.button(text, scope);
  }
  await open(); await session.button("Branding");
  await session.poll("document.querySelector('#brand-name')?.value==='Native locked brand'");
  assert(await session.evaluate("document.querySelector('#brand-name').readOnly && document.querySelector('#brand-accent').disabled && [...document.querySelectorAll('[data-branding-settings] input[type=file]')].every(input=>input.disabled)"), "Locked branding inputs remain writable");
  await session.click("#brand-name"); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type("must not replace branding");
  assert(await session.evaluate("document.querySelector('#brand-name').value==='Native locked brand'"), "Native input changed locked branding");
  await disabledButton("Save", "[data-branding-settings]"); await disabledButton("Reset", "[data-branding-settings]");
  await capture("locked-branding-controls");
  await session.button("Plugins");
  await session.poll("!!document.querySelector('[data-plugin-inventory-id=access-workflow]')");
  await disabledButton("Auto-enable new plugins", "[data-plugin-inventory]");
  await disabledButton("Enabled", "[data-plugin-inventory-id=access-workflow]");
  await capture("locked-plugin-policy-controls");
  await session.button("Access workflow settings");
  await session.poll("document.querySelector('#settings-field-message')?.value==='locked retained settings consumer'");
  assert(await session.evaluate("['message','limit'].every(key=>{const input=document.querySelector('#settings-field-'+key);return !!input&&(input.readOnly||input.disabled);})"), "Actual locked declarative fields remain writable");
  await session.click("#settings-field-message"); await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await session.type("must not replace plugin settings");
  assert(await session.evaluate("document.querySelector('#settings-field-message').value==='locked retained settings consumer'"), "Native input changed locked declarative settings");
  await capture("locked-declarative-controls");
  await session.click('[data-permission-page="access-workflow"]');
  await session.poll("!!document.querySelector('[data-plugin-permission-panel] [data-permission-scope=\"host:127.0.0.1:9\"]')");
  await disabledButton("Allow network", "[data-plugin-permission-panel]");
  await disabledButton("Delete approval", '[data-permission-scope="host:127.0.0.1:9"]');
  await disabledButton("Approve", '[data-permission-scope="host:127.0.0.1:10"]');
  await capture("locked-permission-controls");
  const publication = await api(`plugin-host/${id}/commands/request`, "POST", {});
  assert(publication.status === 200 && publication.body.result.requestId, "Settings lock blocked normal Worker request publication");
  const requestId = publication.body.result.requestId;
  await session.poll("!!document.querySelector('#permission-request-title') && document.querySelector('[data-modal-top=true]').textContent.includes('Native locked request fixture')");
  assert(await session.evaluate("[...document.querySelectorAll('[data-permission-request-choices] input,[data-permission-request-choices] button')].every(input=>input.disabled)"), "Locked request choices remain writable");
  await disabledButton("Deny", "[data-modal-top=true]"); await disabledButton("Approve selected request", "[data-modal-top=true]");
  await capture("locked-permission-request-decisions");
  await session.button("Review later", "[data-modal-top=true]"); await session.poll("!document.querySelector('#permission-request-title')");
  const permissionView = (await api(`plugin-host/${id}/permissions`)).body;
  const ledgerFile = `${state}/plugin-network/${id}.json`, ledger = await Deno.readTextFile(ledgerFile);
  const catalog = (await api("plugin-host")).body, view = (await api("access")).body;
  const controls = { revision: permissionView.revision, signature: permissionView.signature, requestSourceKey: permissionView.requestSourceKey, requestSourceRevision: permissionView.requestSourceRevision, allowNetwork: true, approvedNetwork: permissionView.requestedNetwork, approvedImports: [] };
  const rejected = [];
  for (const [route, method, body] of [["plugin-host/policy", "PUT", { autoEnable: true, revision: catalog.policy.revision, signature: catalog.policy.signature }], [`plugin-host/${id}/enabled`, "PUT", { enabled: false, revision: catalog.policy.revision, signature: catalog.policy.signature }], [settingsRoute, "PUT", { values: { message: "blocked direct settings", limit: 5 }, revision: seeded.body.revision }], [`plugin-host/${id}/permissions`, "PUT", controls], [`plugin-host/${id}/permission-requests/${requestId}/decision`, "POST", { ...controls, decision: "approve" }], ["access", "PUT", { mode: "none", readOnlySettings: false, revision: view.revision, signature: view.signature }], ["access/totp-enrolment", "POST", {}], ["setup/reset", "POST", {}]]) {
    const result = await api(route, method, body); assert(result.status === 403, `Locked real mutation escaped: ${route}`); rejected.push(route);
  }
  const form = new FormData(); form.append("name", "blocked direct branding");
  const brand = await fetch(`${baseUrl}/_/api/brand`, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
  assert(brand.status === 403, "Locked real branding mutation escaped"); await brand.body?.cancel(); rejected.push("brand");
  for (const file of files) assert(await Deno.readTextFile(`${state}/${file}`) === retained[file], `Locked settings API/UI changed ${file}`);
  assert(await Deno.readTextFile(ledgerFile) === ledger, "Locked approval/decision changed the real ledger");
  assert((await api("plugin-host/permission-requests")).body.some(request => request.id === requestId && request.state === "pending"), "Readonly review silently decided the actual request");
  assert(writes.length === 0, "Disabled UI issued a covered settings mutation");
  await session.button("Access");
  assert(!await session.evaluate("[...document.querySelector('[data-modal-top=true]').querySelectorAll('button')].some(button=>button.textContent.trim()==='Change access mode')"), "Locked Access exposes self-unlock");
  await session.button("Appearance"); await session.click('[data-theme-id="globnotes-dark"]');
  await session.poll("localStorage.getItem('globnotes-theme')==='globnotes-dark'&&document.body.classList.contains('dark')");
  await session.button("Editor"); await session.click('[data-modal-top=true] button.group');
  await session.poll("localStorage.getItem('viewLineNumbers')==='true'&&document.querySelectorAll('.toast-viewer .line-numbers-rows>span').length>=2");
  await session.button("Diagnostics"); await session.click('[data-modal-top=true] button.group');
  await session.poll("localStorage.getItem('debug')==='true'&&document.body.innerText.includes('debug:change')");
  await session.button("Keybindings"); await session.button("Custom"); await session.click('[data-command-binding="app:open-settings"] button');
  await session.key("g", { code: "KeyG", modifiers: 3, windowsVirtualKeyCode: 71 });
  await session.poll("document.querySelector('[data-command-binding=\"app:open-settings\"]').textContent.includes('Ctrl+Alt+G')");
  await close();
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
  await session.key("g", { code: "KeyG", modifiers: 3, windowsVirtualKeyCode: 71 }); await session.poll("!!document.querySelector('#settings-modal-title')");
  assert(await session.evaluate("document.querySelectorAll('#settings-modal-title').length===1"), "Locked local remap did not reach the one Settings handler"); await close();
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
  await session.button("Edit", ".content-column"); await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')"); await session.click(".cm-content"); await session.type("Locked controls public note consumer\n"); await session.button("Save", ".content-column");
  await session.poll("fetch('/_/api/notes/Seed').then(r=>r.json()).then(note=>note.content.includes('Locked controls public note consumer'))");
  await session.poll("(()=>{const button=[...document.querySelectorAll('.content-column button')].find(button=>button.textContent.trim()==='Save');return button?.getAttribute('aria-busy')==='false'&&!button.querySelector('.animate-spin');})()");
  assert((await Deno.readTextFile(`${vault}/Seed.md`)).includes("Locked controls public note consumer"), "Locked controls prevented actual public note persistence");
  let report;
  for (let end = Date.now() + 5000;;) {
    report = (await api(`plugin-host/${id}/commands/report`, "POST", {})).body.result;
    if (report.content?.includes("Locked controls public note consumer")) break;
    if (Date.now() >= end) throw Error("Locked public hook/private-data consumer deadline");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(report.owner === owner && report.message === "locked retained settings consumer", "Settings lock/local preferences replaced owner or lost real settings/hook consumer");
  assert(JSON.parse(await Deno.readTextFile(`${state}/plugin-data/${id}/data.json`)).values.content.includes("Locked controls public note consumer"), "Locked workflow private data did not persist");
  const sourceUrl = await session.evaluate("location.href");
  await session.evaluate("window.__lockedPreferencesDocument='before-reload';true");
  await session.send("Page.reload");
  await session.poll("window.__lockedPreferencesDocument===undefined&&document.readyState==='complete'&&!!document.querySelector('.cm-content')&&document.querySelector('.cm-content').textContent.includes('Locked controls public note consumer')");
  assert(await session.evaluate(`location.href===${JSON.stringify(sourceUrl)}`), "Reload did not retain the Source URL/editor ownership");
  assert(await session.evaluate("localStorage.getItem('globnotes-theme')==='globnotes-dark'&&localStorage.getItem('viewLineNumbers')==='true'&&localStorage.getItem('debug')==='true'&&localStorage.getItem('globnotes-keybindings')==='custom'&&JSON.parse(localStorage.getItem('globnotes-keybindings-custom'))['app:open-settings'].other==='Ctrl+Alt+G'"), "Locked-public local preferences/remap did not persist across reload");
  // Review-later is browser-lifetime deferral, not a persisted decision. A
  // fresh document legitimately reviews the still-pending readonly request.
  await session.poll("!!document.querySelector('#permission-request-title')");
  await session.button("Review later", "[data-modal-top=true]"); await session.poll("!document.querySelector('#permission-request-title')");
  if (await session.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
  await session.button("Edit", ".content-column");
  await session.poll("!!document.querySelector('.toast-viewer')&&!document.querySelector('.cm-content')&&document.body.classList.contains('dark')&&document.querySelectorAll('.toast-viewer .line-numbers-rows>span').length>=2");
  await session.key("g", { code: "KeyG", modifiers: 3, windowsVirtualKeyCode: 71 }); await session.poll("!!document.querySelector('#settings-modal-title')"); await close();
  for (const file of files) assert(await Deno.readTextFile(`${state}/${file}`) === retained[file], `Local preferences changed vault-owned ${file}`);
  assert(writes.length === 0, "Local preferences caused a covered backend settings write"); stop();
  return { realCoveredApisDenied: rejected, realConfigPolicySettingsBytesRetained: true, actualPermissionLedgerRetained: true, requestPublishedWhileLocked: true, readonlyRequestStillPending: true, disabledUiMutationRequests: writes, localThemeRemapLineNumbersDebugConsumedAndReloaded: true, publicNoteApiAndDiskConsumer: true, sameWorkflowOwner: true, settingsDrivenHookAndPrivateDataConsumer: true };
}
