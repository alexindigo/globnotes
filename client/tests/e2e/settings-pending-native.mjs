// Feature-owned response gates exercise the real browser/Settings/store chain.
// No application clock, request helper, or production acknowledgement is mocked.
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
export async function exerciseSettingsPending({ session, server, directory, headers }) {
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const path = "/_/api/plugin-host/session-guard/settings/preferences";
  const gate = { next: false, response: null, writes: [] };
  const observeGate = event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PUT" && new URL(event.params.request.url).pathname === path) {
      gate.writes.push({ requestId: event.params.requestId, at: Date.now() });
    }
    if (event.method !== "Fetch.requestPaused") return;
    const response = event.params;
    if (response.request.method === "PUT" && gate.next) {
      gate.next = false;
      gate.response = { requestId: response.requestId, status: response.responseStatusCode, at: Date.now() };
    } else session.send("Fetch.continueRequest", { requestId: response.requestId }).catch(error => { gate.error = error.message; });
  };
  const pollGate = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert(Date.now() < deadline, "Response-gate observation deadline");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(!gate.error, gate.error);
  };
  const read = async () => {
    const response = await fetch(`${server.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5000) });
    assert(response.ok, "Authoritative Settings read failed");
    return response.json();
  };
  const replace = async (selector, value) => {
    await session.click(selector);
    await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    if (value) await session.type(value);
    else await session.key("Backspace", { windowsVirtualKeyCode: 8 });
  };
  await session.click('[title="Open sidebar"]');
  await session.click('[aria-label="Settings"]');
  await session.poll("!!document.querySelector('#settings-modal-title')");
  await session.click('[data-settings-nav-id="plugin:session-guard"]');
  await session.poll("document.querySelector('#settings-field-message')?.matches('input:not([readonly]):not([disabled])')");
  await exerciseSettingsIdleGeometry({ session, directory });
  await exerciseSettingsStatusLine({ session, directory });
  const removeObserver = session.page.onEvent(observeGate);
  const initial = await read();
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `*${path}`, requestStage: "Response" }] });
  gate.next = true;
  await replace("#settings-field-message", "late acknowledged setting");
  await session.key("Enter", { windowsVirtualKeyCode: 13 });
  await pollGate(() => !!gate.response);
  assert(gate.response.status === 200, "Held write did not succeed upstream");
  const persisted = await read();
  assert(persisted.values.message === "late acknowledged setting" && persisted.revision === initial.revision + 1, "Held response has no actual persisted outcome");
  await replace("#settings-field-limit", "");
   await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Settings request outcome is unknown')");
    const retryUnavailable = "![...document.querySelectorAll('[data-modal-top=true] button')].some(button=>button.textContent.trim()==='Check current status')";
   assert(await session.evaluate(retryUnavailable), "Observation deadline freed the unresolved write for retry");
  await session.button("Appearance");
  await pollGate(() => Date.now() - gate.response.at > 11000);
   assert(await session.evaluate("!!document.querySelector('#settings-modal-title') && document.querySelector('#settings-field-limit')?.value==='' && !document.querySelector('[data-appearance-settings]') && !document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')"), "Unresolved wire allowed departure/discard or erased newer invalid input");
  assert(gate.writes.length === 1, "Pending write was repeated before its outcome");
  const lateResponse = gate.response;
  await session.send("Fetch.continueRequest", { requestId: lateResponse.requestId });
  gate.response = null;
   await session.poll("document.querySelector('#settings-field-message')?.value==='late acknowledged setting' && document.querySelector('#settings-field-limit')?.value==='' && !document.querySelector('[data-modal-top=true]')?.textContent.includes('Settings request outcome is unknown')");
  assert((await read()).revision === persisted.revision && gate.writes.length === 1, "Late acknowledgement replayed the write");
  await session.button("Appearance");
   await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')");
  await session.key("Escape", { windowsVirtualKeyCode: 27 });
   await session.poll("document.querySelector('#settings-field-limit')?.value==='' && !document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')");
  await session.button("Appearance");
   await session.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Unsaved changes')");
  await session.button("Discard", '[data-modal-top="true"]');
  await session.poll("!!document.querySelector('[data-appearance-settings]')");
  await session.click('[data-settings-nav-id="plugin:session-guard"]');
  await session.poll("document.querySelector('#settings-field-limit')?.value==='5'");
  const late = { name: "native-pending-wire-late-acknowledgement", revision: persisted.revision, values: persisted.values, upstreamStatus: lateResponse.status, heldBeyondDeadline: true, duplicateWrites: 0, newerInvalidDraftRetained: true, departureBlockedWhileUnresolved: true, topmostEscapeKeptDraft: true, explicitDiscard: true };
  await Deno.writeTextFile(`${directory}/pending-step-1.json`, JSON.stringify(late, null, 2), { createNew: true });

  gate.next = true;
  await replace("#settings-field-message", "lost acknowledgement recovered");
  await session.key("Enter", { windowsVirtualKeyCode: 13 });
  await pollGate(() => !!gate.response);
  assert(gate.response.status === 200, "Lost-acknowledgement control did not persist upstream");
  const recovered = await read();
  assert(recovered.values.message === "lost acknowledgement recovered" && recovered.revision === persisted.revision + 1, "Lost receipt control has no actual persisted result");
  await session.send("Fetch.failRequest", { requestId: gate.response.requestId, errorReason: "ConnectionClosed" });
  gate.response = null;
   await session.poll("[...document.querySelectorAll('[data-modal-top=true] button')].some(button=>button.textContent.trim()==='Check current status' && !button.disabled)");
   assert(await session.evaluate("document.querySelector('#settings-field-message')?.value==='lost acknowledgement recovered'"), "Lost acknowledgement erased the retained submission");
  assert(gate.writes.length === 2, "Unknown outcome was automatically retried");
  await session.button("Check current status");
   await session.poll("document.querySelector('#settings-field-message')?.value==='lost acknowledgement recovered' && !document.querySelector('[data-modal-top=true]')?.textContent.includes('Your edit is kept')");
  assert(gate.writes.length === 2 && JSON.stringify(await read()) === JSON.stringify(recovered), "Read-back recovery repeated an already-persisted write");
  await session.click('[aria-label="Close settings"]');
  await session.poll("!document.querySelector('#settings-modal-title')");
   assert(await session.evaluate("document.querySelector('.cm-content')===window.__gpsEditor && document.querySelector('.cm-content')?.textContent.includes('GPS pending dirty marker')"), "Recovery replaced or erased the dirty note editor");
  const recovery = { name: "native-lost-acknowledgement-read-back", revision: recovered.revision, values: recovered.values, submittedWrites: gate.writes.length, noReplayAfterExplicitReview: true, settingsClosedAfterRecovery: true, dirtyEditorRetained: true, expectedTransportFailure: "ConnectionClosed" };
  await Deno.writeTextFile(`${directory}/pending-step-2.json`, JSON.stringify(recovery, null, 2), { createNew: true });
  await session.send("Fetch.disable");
  removeObserver();
  return [late, recovery];
}

async function exerciseSettingsIdleGeometry({ session, directory }) {
  const results = [];
  for (const width of [1280, 360, 380, 480]) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1280 ? 900 : 1400, deviceScaleFactor: 1, mobile: false });
    for (const [page, selector] of [
      ['core:branding', '[data-branding-settings]'],
      ['core:sync', '[data-sync-settings]'],
      ['plugin:session-guard', '[data-declarative-settings]'],
    ]) {
      await session.click(`[data-settings-nav-id="${page}"]`);
      await session.poll(`!!document.querySelector('${selector}') && !!document.querySelector('[data-settings-status]') && document.querySelector('[data-settings-status]').textContent!=='Loading sync settings...'`);
      await session.evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      const geometry = await session.evaluate(`(()=>{
        const title=document.querySelector('[data-settings-page-heading]').getBoundingClientRect();
        const heading=document.querySelector('.settings-page-heading').getBoundingClientRect();
        const body=document.querySelector('${selector}').getBoundingClientRect();
        return {titleBottom:title.bottom,bodyTop:body.top,distance:body.top-title.bottom,headingHeight:heading.height};
      })()`);
      results.push({ width, page, ...geometry });
    }
  }
  await Deno.writeTextFile(`${directory}/idle-geometry.json`, JSON.stringify(results, null, 2), { createNew: true });
  // Measured on origin/main b227ecd with this same fixture and browser recipe.
  for (const result of results) {
    const expected = result.page === 'core:branding' ? { distance:24, headingHeight:27 }
      : result.page === 'core:sync' ? { distance:53, headingHeight:27 }
      : result.width === 360 ? { distance:76, headingHeight:79 } : { distance:34.5, headingHeight:44 };
    if (Math.abs(result.distance - expected.distance) > 0.5 || Math.abs(result.headingHeight - expected.headingHeight) > 0.5) throw Error(`Idle settings geometry differs from main: ${JSON.stringify({result,expected})}`);
  }
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

// Hold the real successful acknowledgement, not the write or a fabricated reply.
async function exerciseSettingsStatusLine({ session, directory }) {
  const path = "/_/api/plugin-host/session-guard/settings/preferences";
  let response, gateError;
  const requests = [];
  const stop = session.page.onEvent(event => {
    if (event.method === 'Network.requestWillBeSent' && event.params.request.method === 'PUT') requests.push(event.params.request);
    if (event.method !== "Fetch.requestPaused") return;
    if (event.params.request.method === "PUT") response = event.params;
    else session.send("Fetch.continueRequest", { requestId: event.params.requestId }).catch(error => { gateError = error; });
  });
  const snapshot = () => session.evaluate(`({
    first:document.querySelector('#settings-field-message').getBoundingClientRect().top,
    next:document.querySelector('#settings-field-limit').getBoundingClientRect().top,
    headingHeight:document.querySelector('.settings-page-heading').getBoundingClientRect().height,
    lines:['[data-settings-status]','[data-note-save-status]'].map(selector=>{
      const el=document.querySelector(selector);return el?{height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight)}:null;
    }),
    saving:document.querySelector('[data-settings-status]')?.textContent==='Saving…',
    insecure:!isSecureContext, origin:location.origin
  })`);
  const capture = async label => {
    const picture = await session.send("Page.captureScreenshot", { format: "png" });
    await Deno.writeFile(`${directory}/status-${label}.png`, Uint8Array.from(atob(picture.data), char => char.charCodeAt(0)), { createNew: true });
  };
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `*${path}`, requestStage: "Response" }] });
  try {
    for (const [label, width, height] of [['desktop',1280,900], ['narrow',360,1400]]) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const value = label === 'desktop' ? 'Stable settings feedback' : 'Stable settings feedback narrow';
    const startWrites = requests.length;
    await session.click("#settings-field-message");
    await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await session.type(value);
    await session.evaluate("document.fonts.ready.then(()=>true)");
    const before = await snapshot();
    await capture(`${label}-idle-before`);
    await session.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9 });
    await waitUntil(() => {
      if (gateError) throw gateError;
      return response ? done() : pending("real blur save acknowledgement");
    }, { label: "settings status held save" });
    await session.poll("document.querySelector('[data-settings-status]')?.textContent==='Saving…'");
    const during = await snapshot();
    await capture(`${label}-saving`);
    const status = response.responseStatusCode;
    await session.send("Fetch.continueRequest", { requestId: response.requestId });
    response = null;
    await session.poll("document.querySelector('[data-settings-status]')?.textContent===''");
    const after = await snapshot();
    await capture(`${label}-idle-after`);
    const saved = await session.evaluate(`fetch('${path}').then(r=>r.json())`);
    const result = { before, during, after, status, saved, requests, movement: {
      firstDuring: during.first - before.first, firstAfter: after.first - before.first,
      nextDuring: during.next - before.next, nextAfter: after.next - before.next,
    } };
    await Deno.writeTextFile(`${directory}/status-geometry-${label}.json`, JSON.stringify(result, null, 2), { createNew: true });
    if (status !== 200 || saved.values.message !== value || !before.insecure || before.saving || !during.saving || after.saving || requests.length !== startWrites + 1) throw Error("Status probe did not observe one real saved setting on insecure HTTP");
    if (Object.values(result.movement).some(value => value !== 0)) throw Error(`Settings moved during save: ${JSON.stringify(result.movement)}`);
    if (before.headingHeight !== during.headingHeight || before.headingHeight !== after.headingHeight) throw Error(`Heading height changed during ${label} save`);
    if ([before, during, after].some(state => state.lines.some(line => !line || line.height !== line.line))) throw Error('Status feedback must reserve exactly one inherited typographic line');
    }
  } finally {
    if (response) await session.send("Fetch.continueRequest", { requestId: response.requestId });
    await session.send("Fetch.disable");
    stop();
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
}
