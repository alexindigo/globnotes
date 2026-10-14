import { nativeSession } from "./native-cdp-session.mjs";
import { settleSettingsInventory } from "./settings-inventory-native.mjs";

export async function exerciseSettingsCrossBrowser({ session: a, server, directory, username, password, vault, state }) {
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const b = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9333) });
  const c = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9333) });
  await Deno.writeTextFile(`${directory}/peer-ownership.json`, JSON.stringify({
    b: { targetId: b.targetId, browserContextId: b.browserContextId }, c: { targetId: c.targetId, browserContextId: c.browserContextId }, serverPid: server.pid,
  }, null, 2), { createNew: true });
  const api = (peer, path, options = {}) => peer.evaluate(`fetch(${JSON.stringify(path)},{...${JSON.stringify(options)},signal:AbortSignal.timeout(5000)}).then(async r=>{const text=await r.text();return {status:r.status,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};})`);
  async function replace(peer, selector, value) { await peer.click(selector); await peer.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); if (value) await peer.type(value); else await peer.key("Backspace", { windowsVirtualKeyCode: 8 }); }
  async function open(peer, page) {
    if (!await peer.evaluate("!!document.querySelector('#settings-modal-title')")) {
      if (await peer.evaluate("!!document.querySelector('[title=\"Open sidebar\"]')")) await peer.click('[title="Open sidebar"]');
      await peer.click('[aria-label="Settings"]'); await peer.poll("!!document.querySelector('#settings-modal-title')");
    }
    await peer.button(page);
    if (page === "Native preferences") await peer.poll("!!document.querySelector('#settings-field-message') && !document.querySelector('#settings-field-message').readOnly");
  }
  async function editMessage(peer, value) {
    await replace(peer, "#settings-field-message", value); await peer.key("Enter", { windowsVirtualKeyCode: 13 });
    await peer.poll(`fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.message===${JSON.stringify(value)})`);
  }
   const outcomes = [];
  async function record(value) {
    outcomes.push(value);
    await Deno.writeTextFile(`${directory}/peer-step-${outcomes.length}.json`, JSON.stringify(value, null, 2), { createNew: true });
    await Deno.writeTextFile(`${directory}/peer-diagnostics-${outcomes.length}.json`, JSON.stringify({ b: { errors: b.errors, events: b.events }, c: { errors: c.errors, events: c.events } }, null, 2), { createNew: true });
  }
  const persistenceStages = [];
  const aBuffer = await a.evaluate("({url:location.href,text:document.querySelector('.cm-content').textContent})");
  async function persistence(label) {
    const acknowledged = await api(a, "/_/api/plugin-host/session-guard/settings/preferences");
    const peer = await api(b, "/_/api/plugin-host/session-guard/settings/preferences");
    assert(acknowledged.status === 200 && JSON.stringify(peer) === JSON.stringify(acknowledged), `${label}: independent peer settings/revision differs`);
    const values = acknowledged.body.values;
    const diskSettings = JSON.parse(await Deno.readTextFile(`${state}/plugin-data/session-guard/settings.json`));
    assert(diskSettings.revision === acknowledged.body.revision && JSON.stringify(diskSettings.values.preferences) === JSON.stringify(values), `${label}: actual settings file differs`);
    assert(await b.evaluate(`document.querySelector('#settings-field-message').value===${JSON.stringify(values.message)} && !!document.querySelector('#settings-field-protect .text-theme-brand')===${JSON.stringify(values.protect)}`), `${label}: peer Settings UI did not consume saved message/toggle`);
    const reportRoute = "/_/api/plugin-host/session-guard/commands/report";
    const reportOptions = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    const before = await api(b, reportRoute, reportOptions);
    assert(before.status === 200 && ["message", "limit", "protect"].every(key => before.body.result[key] === values[key]), `${label}: actual command did not consume saved values`);
    await b.click('[aria-label="Close settings"]'); await b.poll("!document.querySelector('#settings-modal-title')");
    if (await b.evaluate("!!document.querySelector('[title=\"Close sidebar\"]')")) await b.click('[title="Close sidebar"]');
    if (!await b.evaluate("!!document.querySelector('.cm-content')")) {
      await b.button("Edit", ".content-column"); await b.button("Source", ".content-column");
    }
    await b.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
    await b.evaluate("document.fonts.ready.then(()=>true)");
    const literal = `GPS persistence ${label}: ${values.message}\n`;
    await replace(b, ".cm-content", literal);
    assert(await b.evaluate("(()=>{const el=document.querySelector('.cm-content'),r=el.getBoundingClientRect();return (el===document.activeElement||el.contains(document.activeElement))&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), `${label}: native persistence editor focus/hit precondition failed`);
    await b.button("Save", ".content-column");
    await b.poll(`fetch('/_/api/notes/Persistence').then(r=>r.json()).then(note=>note.content===${JSON.stringify(literal)})`);
    await b.poll("(()=>{const button=[...document.querySelectorAll('.content-column button')].find(button=>button.textContent.trim()==='Save');return button?.getAttribute('aria-busy')==='false'&&!button.querySelector('.animate-spin');})()");
    let consumed;
    for (const deadline = Date.now() + 5000;;) {
      consumed = await api(b, reportRoute, reportOptions);
      if (consumed.status === 200 && consumed.body.result.hookLast?.content === literal) break;
      if (Date.now() >= deadline) throw Error(`${label}: real on-save/private-data consumer deadline`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = consumed.body.result;
    assert(result.hookRuns === (before.body.result.hookRuns ?? 0) + 1 && result.hookLast.path === "Persistence" && ["message", "limit", "protect"].every(key => result.hookLast[key] === values[key] && result[key] === values[key]), `${label}: hook/command consumer differs from acknowledged settings`);
    assert(await Deno.readTextFile(`${vault}/Persistence.md`) === literal, `${label}: native Save did not reach exact note disk bytes`);
    const privateData = JSON.parse(await Deno.readTextFile(`${state}/plugin-data/session-guard/data.json`));
    assert(privateData.values.hookRuns === result.hookRuns && JSON.stringify(privateData.values.hookLast) === JSON.stringify(result.hookLast), `${label}: hook consumer did not persist actual private data`);
    assert(await a.evaluate(`location.href===${JSON.stringify(aBuffer.url)} && document.querySelector('.cm-content')===window.__gpsEditor && document.querySelector('.cm-content').textContent===${JSON.stringify(aBuffer.text)}`), `${label}: peer persistence changed A's URL/editor/literal dirty buffer`);
    await open(b, "Native preferences");
    await b.poll(`document.querySelector('#settings-field-message').value===${JSON.stringify(values.message)}`);
    const row = { name: label, revision: acknowledged.body.revision, values, command: { message: result.message, limit: result.limit, protect: result.protect }, hook: result.hookLast, hookRuns: result.hookRuns, exactNoteApiAndDisk: true, privateDataDisk: true, independentPeer: true, originalDirtyEditorAndUrlRetained: true };
    persistenceStages.push(row);
    await Deno.writeTextFile(`${directory}/persistence-${label}.json`, JSON.stringify(row, null, 2), { createNew: true });
  }
   try {
   await c.goto(`${server.baseUrl}/NoteA`); await c.poll("!!document.querySelector('#username')");
  const rejectedRead = await api(c, "/_/api/plugin-host/session-guard/settings/preferences");
  const rejectedCommand = await api(c, "/_/api/plugin-host/session-guard/commands/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert(rejectedRead.status === 401 && rejectedCommand.status === 401, "Unauthenticated peer reached protected settings/commands");
  const count = await api(a, "/_/api/plugin-host/session-guard/commands/report-count", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert(count.status === 200 && count.body.result === 0, "Rejected command had a Worker side effect");
  await b.goto(`${server.baseUrl}/NoteA`); await b.poll("!!document.querySelector('#username')");
  await b.click("#username"); await b.type(username); await b.click("#password"); await b.type(password); await b.button("Log In");
  await b.poll("!document.querySelector('#username') && !!document.querySelector('.toast-viewer')");
  await b.poll("typeof window.__settingsPeerThemeEvents==='number'");
  assert(a.browserContextId !== b.browserContextId && b.browserContextId !== c.browserContextId, "Peer contexts share authentication state");
  await b.goto(`${server.baseUrl}/Persistence`); await b.poll("!!document.querySelector('.toast-viewer') && document.querySelector('.toast-viewer').textContent.includes('Persistence seed.')");
  await open(a, "Native preferences"); await editMessage(a, "A persisted across browsers");
  await open(b, "Native preferences"); await b.poll("document.querySelector('#settings-field-message').value==='A persisted across browsers'");
  await persistence("native-text-enter");
  const beforeBlur = await api(b, "/_/api/plugin-host/session-guard/settings/preferences");
  await replace(b, "#settings-field-message", "B acknowledged value"); await b.click("#settings-field-limit");
  await b.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.message==='B acknowledged value')");
  assert((await api(b, "/_/api/plugin-host/session-guard/settings/preferences")).body.revision === beforeBlur.body.revision + 1, "Distinct native blur did not commit exactly once");
  await a.poll("document.querySelector('#settings-field-message').value==='B acknowledged value'");
  await persistence("native-text-blur");
  await b.click('[aria-label="Close settings"]'); await b.poll("!document.querySelector('#settings-modal-title')");
  await open(b, "Native preferences"); await b.poll("document.querySelector('#settings-field-message').value==='B acknowledged value'");
  await persistence("settings-reopen");
  await record({ name: "independent-authenticated-settings-consumers", contexts: [a.browserContextId, b.browserContextId, c.browserContextId], rejectedRead: rejectedRead.status, rejectedCommand: rejectedCommand.status, rejectedWorkerEffects: count.body.result, reconciled: "B acknowledged value" });

  await replace(a, "#settings-field-limit", "");
  await editMessage(b, "B newer revision");
  await a.poll("document.querySelector('#settings-field-limit').value===''");
  await replace(a, "#settings-field-message", "A retained conflict"); await a.key("Enter", { windowsVirtualKeyCode: 13 });
  await a.poll("document.querySelector('[data-modal-top=true]').textContent.includes('These settings changed elsewhere')");
  assert(await a.evaluate("document.querySelector('#settings-field-message').value==='A retained conflict' && document.querySelector('#settings-field-limit').value===''") , "Conflict erased invalid/newer local drafts");
  await a.button("Appearance"); await a.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  await a.key("Escape", { windowsVirtualKeyCode: 27 });
  await a.poll("document.querySelector('#settings-field-message')?.value==='A retained conflict' && document.querySelector('#settings-field-limit')?.value===''");
  await a.button("Reload"); await a.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  await a.button("Discard", '[data-modal-top="true"]');
  await a.poll("document.querySelector('#settings-field-message')?.value==='B newer revision' && document.querySelector('#settings-field-limit')?.value==='5'");
  await record({ name: "actual-cas-conflict-invalid-draft-recovery", retained: "A retained conflict", explicitDiscardReadBack: "B newer revision", topmostEscapeKeptDraft: true });

  await b.evaluate("window.__settingsPeerDocument='before-reload';true"); await b.send("Page.reload");
  await b.poll("window.__settingsPeerDocument===undefined && (!!document.querySelector('[title=\"Open sidebar\"]') || !!document.querySelector('[aria-label=Settings]')?.getBoundingClientRect().width)");
  await b.poll("typeof window.__settingsPeerThemeEvents==='number'");
  await open(b, "Native preferences"); await b.poll("document.querySelector('#settings-field-message').value==='B newer revision'");
  await persistence("fresh-document-reload");
  await a.click("#settings-field-protect");
  await a.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.protect===true)");
  await b.poll("!!document.querySelector('#settings-field-protect .text-theme-brand')");
  await persistence("native-toggle");
  const guarded = await api(b, "/_/api/notes/NoteA", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newContent: "GPS-blocked peer write" }) });
  assert(guarded.status === 409, "Enabled guard did not consume the persisted peer setting");
  await replace(a, "#settings-field-message", "A recovery after remote disable");
  await open(b, "Plugins"); await b.button("Enabled", '[data-plugin-inventory-id="session-guard"]');
  await a.poll("document.querySelector('#settings-field-message').readOnly && document.querySelector('[data-modal-top=true]').textContent.includes('This page is unavailable')");
  assert(await a.evaluate("document.querySelector('#settings-field-message').value==='A recovery after remote disable'"), "Remote disable lost the recovery draft");
  const disabledCommand = await api(b, "/_/api/plugin-host/session-guard/commands/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const disabledEndpoint = await api(b, "/_/api/plugins/session-guard/ping");
  const unguarded = await api(b, "/_/api/notes/NoteA", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newContent: "GPS-blocked peer write" }) });
  assert(disabledCommand.status === 404 && disabledEndpoint.status === 404 && unguarded.status === 200, "Disable did not remove actual command/endpoint/guard admission");
  const disabledInventory = await settleSettingsInventory(b, "document.querySelector('[data-plugin-inventory-id=\"session-guard\"] button')?.textContent.trim()==='Disabled'");
  await open(b, "Appearance"); const beforeDisabledTheme = await b.evaluate("window.__settingsPeerThemeEvents"); await b.click('[data-theme-id="globnotes-dark"]');
  await b.poll("document.body.classList.contains('dark')"); assert(await b.evaluate("window.__settingsPeerThemeEvents") === beforeDisabledTheme, "Disabled managed browser subscription still fired");
  await open(b, "Keybindings"); assert(!await b.evaluate("!!document.querySelector('[data-command-binding=\"plugin:session-guard:sdk-settings\"]')"), "Disabled browser command remained registered");
  await open(b, "Plugins"); await b.button("Disabled", '[data-plugin-inventory-id="session-guard"]');
  await a.poll("!document.querySelector('#settings-field-message').readOnly");
  assert(await a.evaluate("document.querySelector('#settings-field-message').value==='A recovery after remote disable'"), "Re-enable discarded the recovery draft");
  const enabledInventory = await settleSettingsInventory(b, "document.querySelector('[data-plugin-inventory-id=\"session-guard\"] button')?.textContent.trim()==='Enabled'");
  // Explicitly focus the recovered field before admitting its retained edit.
  await a.click("#settings-field-message"); await a.key("Enter", { windowsVirtualKeyCode: 13 });
  await a.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.message==='A recovery after remote disable')");
  await open(b, "Keybindings"); await b.poll("document.querySelectorAll('[data-command-binding=\"plugin:session-guard:sdk-settings\"]').length===1");
  await open(b, "Appearance"); const beforeEnabledTheme = await b.evaluate("window.__settingsPeerThemeEvents"); await b.click('[data-theme-id="globnotes-light"]');
  await b.poll(`window.__settingsPeerThemeEvents===${beforeEnabledTheme + 1}`);
  const reenabledEndpoint = await api(b, "/_/api/plugins/session-guard/ping");
  const reenabledGuard = await api(b, "/_/api/notes/NoteA", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newContent: "GPS-blocked second peer write" }) });
  assert(reenabledEndpoint.status === 200 && reenabledGuard.status === 409, "Re-enable failed to restore endpoint/guard consumers");
  assert(await a.evaluate("document.querySelector('.cm-content')===window.__gpsEditor && document.querySelector('.cm-content').textContent.includes('GPS cross-browser dirty marker')"), "Peer reconciliation replaced or lost A's dirty editor");
  await record({ name: "remote-disable-reenable-owned-contributions", disabledCommand: 404, disabledEndpoint: 404, disabledGuardRemoved: 200, reenabledEndpoint: 200, reenabledGuard: 409, recoveredDraft: "A recovery after remote disable", enabledSubscriptionDelta: 1, dirtyEditorRetained: true, inventorySettlement: [disabledInventory, enabledInventory] });
  await a.poll("!document.querySelector('[data-modal-top=true]').textContent.includes('Saving…')");
  const beforeRestart = await api(a, "/_/api/plugin-host/session-guard/settings/preferences");
  const aUrl = await a.evaluate("location.href");
  const restarted = await server.restart();
  const afterRestart = await api(a, "/_/api/plugin-host/session-guard/settings/preferences");
  assert(afterRestart.status === 200 && JSON.stringify(afterRestart.body) === JSON.stringify(beforeRestart.body), "Restart did not retain exact settings/revision under the existing credentials");
  await open(b, "Native preferences"); await b.poll("document.querySelector('#settings-field-message').value==='A recovery after remote disable'");
  await persistence("backend-restart");
  const restartedCommand = await api(b, "/_/api/plugin-host/session-guard/commands/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const restartedGuard = await api(b, "/_/api/notes/NoteA", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newContent: "GPS-blocked restart write" }) });
  assert(restartedCommand.status === 200 && restartedCommand.body.result.message === "A recovery after remote disable" && restartedGuard.status === 409, "Restarted command/hook did not consume persisted values");
  assert(await a.evaluate(`location.href===${JSON.stringify(aUrl)} && document.querySelector('.cm-content')===window.__gpsEditor && document.querySelector('.cm-content').textContent.includes('GPS cross-browser dirty marker')`), "Backend restart changed A's URL/editor/dirty buffer");
  await record({ name: "same-origin-server-restart-settings-consumers", ...restarted, revision: afterRestart.body.revision, values: afterRestart.body.values, command: restartedCommand.body.result, guard: restartedGuard.status, existingCredentialsRetained: true, dirtyEditorAndUrlRetained: true, expectedStreamTransportClosure: true });
  assert(persistenceStages.length === 6, "Incomplete native settings persistence matrix");
  await record({ name: "native-settings-persistence-command-and-hook-matrix", stages: persistenceStages });
  console.log("GPS-03 SETTINGS PERSISTENCE OK (six native command/hook/API/disk stages)");
  await Deno.writeTextFile(`${directory}/peer-diagnostics.json`, JSON.stringify({ b: { errors: b.errors, events: b.events }, c: { errors: c.errors, events: c.events } }, null, 2), { createNew: true });
  assert(b.errors.length === 0 && c.errors.length === 0, "Independent peer browser exception");
  return outcomes;
  } finally {
    await Deno.writeTextFile(`${directory}/peer-final-diagnostics.json`, JSON.stringify({ b: { errors: b.errors, events: b.events }, c: { errors: c.errors, events: c.events } }), { createNew: true });
    await b.close(); await c.close();
    await Deno.writeTextFile(`${directory}/peer-closure.json`, JSON.stringify({ bClosed: true, cClosed: true }), { createNew: true });
  }
}
