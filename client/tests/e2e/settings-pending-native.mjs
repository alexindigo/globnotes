// Feature-owned response gates exercise the real browser/Settings/store chain.
// No application clock, request helper, or production acknowledgement is mocked.
export async function exerciseSettingsPending({ session, server, directory }) {
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const path = "/_/api/plugin-host/session-guard/settings/preferences";
  const gate = { next: false, response: null, writes: [] };
  const removeObserver = session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PUT" && new URL(event.params.request.url).pathname === path) {
      gate.writes.push({ requestId: event.params.requestId, at: Date.now() });
    }
    if (event.method !== "Fetch.requestPaused") return;
    const response = event.params;
    if (response.request.method === "PUT" && gate.next) {
      gate.next = false;
      gate.response = { requestId: response.requestId, status: response.responseStatusCode, at: Date.now() };
    } else session.send("Fetch.continueRequest", { requestId: response.requestId }).catch(error => { gate.error = error.message; });
  });
  const pollGate = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert(Date.now() < deadline, "Response-gate observation deadline");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(!gate.error, gate.error);
  };
  const read = async () => {
    const response = await fetch(`${server.baseUrl}${path}`, { signal: AbortSignal.timeout(5000) });
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
  await session.button("Native preferences");
  await session.poll("!!document.querySelector('#settings-field-message') && !document.querySelector('#settings-field-message').readOnly");
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
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Settings request outcome is unknown')");
  const retryDisabled = "[...document.querySelector('[data-modal-top=true]').querySelectorAll('button')].find(button=>button.textContent.trim()==='Review / Retry')?.disabled===true";
  assert(await session.evaluate(retryDisabled), "Observation deadline freed the unresolved write for retry");
  await session.button("Appearance");
  await pollGate(() => Date.now() - gate.response.at > 11000);
  assert(await session.evaluate("!!document.querySelector('#settings-modal-title') && document.querySelector('#settings-field-limit')?.value==='' && !document.querySelector('[data-appearance-settings]') && !document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')"), "Unresolved wire allowed departure/discard or erased newer invalid input");
  assert(gate.writes.length === 1, "Pending write was repeated before its outcome");
  const lateResponse = gate.response;
  await session.send("Fetch.continueRequest", { requestId: lateResponse.requestId });
  gate.response = null;
  await session.poll("document.querySelector('#settings-field-message')?.value==='late acknowledged setting' && document.querySelector('#settings-field-limit')?.value==='' && !document.querySelector('[data-modal-top=true]').textContent.includes('Settings request outcome is unknown')");
  assert((await read()).revision === persisted.revision && gate.writes.length === 1, "Late acknowledgement replayed the write");
  await session.button("Appearance");
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  await session.key("Escape", { windowsVirtualKeyCode: 27 });
  await session.poll("document.querySelector('#settings-field-limit')?.value==='' && !document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  await session.button("Appearance");
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  await session.button("Discard", '[data-modal-top="true"]');
  await session.poll("!!document.querySelector('[data-appearance-settings]')");
  await session.button("Native preferences");
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
  await session.poll("[...document.querySelector('[data-modal-top=true]').querySelectorAll('button')].some(button=>button.textContent.trim()==='Review / Retry' && !button.disabled)");
  assert(await session.evaluate("document.querySelector('#settings-field-message').value==='lost acknowledgement recovered'"), "Lost acknowledgement erased the retained submission");
  assert(gate.writes.length === 2, "Unknown outcome was automatically retried");
  await session.button("Review / Retry");
  await session.poll("document.querySelector('#settings-field-message')?.value==='lost acknowledgement recovered' && !document.querySelector('[data-modal-top=true]').textContent.includes('Your edit is kept')");
  assert(gate.writes.length === 2 && JSON.stringify(await read()) === JSON.stringify(recovered), "Read-back recovery repeated an already-persisted write");
  await session.click('[aria-label="Close settings"]');
  await session.poll("!document.querySelector('#settings-modal-title')");
  assert(await session.evaluate("document.querySelector('.cm-content')===window.__gpsEditor && document.querySelector('.cm-content').textContent.includes('GPS pending dirty marker')"), "Recovery replaced or erased the dirty note editor");
  const recovery = { name: "native-lost-acknowledgement-read-back", revision: recovered.revision, values: recovered.values, submittedWrites: gate.writes.length, noReplayAfterExplicitReview: true, settingsClosedAfterRecovery: true, dirtyEditorRetained: true, expectedTransportFailure: "ConnectionClosed" };
  await Deno.writeTextFile(`${directory}/pending-step-2.json`, JSON.stringify(recovery, null, 2), { createNew: true });
  await session.send("Fetch.disable");
  removeObserver();
  return [late, recovery];
}
