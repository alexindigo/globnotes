// Feature-owned native Settings consumers. No shared CDP/helper changes.
import { exerciseSettingsFields } from "./settings-fields-native.mjs";
export async function exerciseInlineSettings({ session, server, vault, state, directory }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const evidence = [];
  async function record(row) {
    evidence.push(row);
    await Deno.writeTextFile(`${directory}/native-step-${evidence.length}.json`, JSON.stringify(row, null, 2), { createNew: true });
  }
  const inspect = expression => session.evaluate(expression);
  const stored = () => inspect("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json())");
  async function replace(selector, value) {
    await session.click(selector);
    await session.key("a", { code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    if (value) await session.type(value);
    else await session.key("Backspace", { windowsVirtualKeyCode: 8 });
  }
  async function close() {
    await session.click('[aria-label="Close settings"]');
    await session.poll("!document.querySelector('#settings-modal-title')");
  }
  async function open() {
    if (await inspect("!!document.querySelector('[title=\"Open sidebar\"]')")) await session.click('[title="Open sidebar"]');
    await session.click('[aria-label="Settings"]');
    await session.poll("!!document.querySelector('#settings-modal-title')");
  }
  async function palette(label) {
    await session.key("p", { code: "KeyP", modifiers: 2, windowsVirtualKeyCode: 80 });
    await session.poll("!!document.querySelector('input[placeholder=\"Type a command…\"]')");
    await session.click('input[placeholder="Type a command…"]');
    await session.type(label);
    await session.poll(`document.querySelector('[data-modal-top=true] li')?.textContent.includes(${JSON.stringify(label)})`);
    await session.key("Enter", { windowsVirtualKeyCode: 13 });
    await session.poll("!document.querySelector('input[placeholder=\"Type a command…\"]')");
  }
  await open();
  assert(await inspect("document.querySelectorAll('#settings-modal-title').length === 1"), "Settings gear created duplicate instances");
  await session.button("Appearance");
  await session.click('[data-theme-id="globnotes-dark"]');
  await session.poll("localStorage.getItem('globnotes-theme') === 'globnotes-dark' && document.body.classList.contains('dark')");
  await record({ name: "inline-appearance-effect", theme: await inspect("localStorage.getItem('globnotes-theme')") });

  await session.button("Keybindings");
  await session.button("Custom");
  await session.poll("!!document.querySelector('[data-command-binding=\"app:open-settings\"] button')");
  await session.click('[data-command-binding="app:open-settings"] button');
  await session.key("g", { code: "KeyG", modifiers: 3, windowsVirtualKeyCode: 71 });
  await session.poll("document.querySelector('[data-command-binding=\"app:open-settings\"]').textContent.includes('Ctrl+Alt+G')");
  await close();
  if (await inspect("!!document.querySelector('[title=\"Close sidebar\"]')")) await session.click('[title="Close sidebar"]');
  await session.key("g", { code: "KeyG", modifiers: 3, windowsVirtualKeyCode: 71 });
  await session.poll("!!document.querySelector('#settings-modal-title')");
  assert(await inspect("document.querySelectorAll('#settings-modal-title').length === 1 && document.querySelector('.cm-content') === window.__gpsEditor"), "Remapped Settings action lost ownership");
  await inspect("window.__gpsSettingsTitle=document.querySelector('#settings-modal-title');true");
  await session.key("g", { code: "KeyG", modifiers: 3, windowsVirtualKeyCode: 71 });
  await session.poll("document.activeElement===document.querySelector('[aria-label=\"Close settings\"]')");
  assert(await inspect("document.querySelector('#settings-modal-title')===window.__gpsSettingsTitle && document.querySelectorAll('#settings-modal-title').length===1"), "Repeated remapped opening replaced or duplicated Settings");
  await record({ name: "native-remapped-settings-action", sameEditor: true, instances: 1, repeatedOpenSameDialog: true });

  await session.button("Branding");
  await replace("#brand-name", "Native inline brand");
  await session.button("Save", "[data-branding-settings]");
  await session.poll("fetch('/_/api/config').then(r=>r.json()).then(c=>c.brand.name==='Native inline brand')");
  const config = JSON.parse(await Deno.readTextFile(`${state}/config.json`));
  assert(config.brand_name === "Native inline brand", "Inline branding did not reach persisted config");
  await session.button("Reset", "[data-branding-settings]");
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Reset branding?')");
  await session.key("Escape", { windowsVirtualKeyCode: 27 });
  await session.poll("!document.querySelector('[data-modal-top=true]').textContent.includes('Reset branding?')");
  assert(await inspect("document.querySelector('#brand-name').value === 'Native inline brand'"), "Cancelling reset erased Branding");
  await record({ name: "inline-branding-disk-and-cancel", persisted: config.brand_name });

  await session.button("Keybindings");
  await session.poll("!!document.querySelector('[data-command-binding=\"plugin:session-guard:sdk-settings\"]')");
  await session.button("Obsidian");
  await close();
  await palette("Open settings");
  await session.poll("!!document.querySelector('#settings-modal-title') && !!document.querySelector('[data-keybindings-settings]')");
  assert(await inspect("document.querySelectorAll('#settings-modal-title').length===1 && document.querySelector('.cm-content')===window.__gpsEditor"), "Built-in palette Settings action lost ownership");
  await close();
  await palette("Native SDK Settings");
  await session.poll("!!document.querySelector('#settings-modal-title') && !!document.querySelector('#settings-field-message') && !document.querySelector('#settings-field-message').readOnly");
  assert(await inspect("document.querySelectorAll('#settings-modal-title').length===1 && document.querySelector('.cm-content')===window.__gpsEditor"), "Real SDK Settings dispatch did not reach the common retained dialog");
  await record({ name: "native-palette-sdk-settings-actions", builtInPalette: true, pluginSdkPage: "plugin:session-guard:preferences", sameEditor: true, instances: 1 });

  await session.button("Native preferences");
  await session.poll("!!document.querySelector('#settings-field-message') && !document.querySelector('#settings-field-message').readOnly");
  await replace("#settings-field-message", "native committed message");
  await session.key("Enter", { windowsVirtualKeyCode: 13 });
  await session.click("#settings-field-limit");
  await session.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.message==='native committed message')");
  const acknowledged = await stored();
  assert(acknowledged.revision === 1, "Enter/blur submitted the same edit more than once");
  const command = await inspect("fetch('/_/api/plugin-host/session-guard/commands/report',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())");
  assert(command.result.message === acknowledged.values.message, "Actual server command did not consume UI settings");
  const fields = await exerciseSettingsFields({ session, readSettings: stored, replace });
  await record(fields);
  const beforeInvalid = await stored();
  await replace("#settings-field-limit", "");
  await session.button("Appearance");
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  assert(await inspect("[...document.querySelector('[data-modal-top=true]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Save / Retry').disabled"), "Invalid input was allowed to save");
  await session.key("Escape", { windowsVirtualKeyCode: 27 });
  await session.poll("!!document.querySelector('#settings-field-limit') && !document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  assert(await inspect("document.querySelector('#settings-field-limit').value === ''"), "Escape discarded invalid raw input");
  await session.button("Appearance");
  await session.poll("document.querySelector('[data-modal-top=true]').textContent.includes('Unsaved settings')");
  await session.button("Discard", '[data-modal-top="true"]');
  await session.poll("!!document.querySelector('[data-appearance-settings]')");
  await session.button("Native preferences");
  await session.poll("document.querySelector('#settings-field-limit')?.value === '5'");
  assert((await stored()).revision === beforeInvalid.revision, "Invalid/Discard flow mutated persisted settings");
  await record({ name: "native-settings-ack-and-invalid-draft", values: acknowledged.values, revision: acknowledged.revision, command: command.result, topmostEscapeRetainedDraft: true });

  await session.click("#settings-field-protect");
  await session.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.protect===true)");
  const before = await Deno.readTextFile(`${vault}/NoteA.md`);
  const guard = await inspect("fetch('/_/api/notes/NoteA',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({newContent:'GPS-blocked inline settings'})}).then(async r=>({status:r.status,body:await r.json()}))");
  assert(guard.status === 409 && guard.body.detail === "session guard protection", "Real pre-save guard did not consume the native toggle");
  assert(await Deno.readTextFile(`${vault}/NoteA.md`) === before, "Guarded write changed disk");
  assert(await inspect("document.querySelector('.cm-content') === window.__gpsEditor && document.querySelector('.cm-content').textContent.includes('GPS inline dirty marker')"), "Inline Settings lost the original dirty editor");
  await close();
  await record({ name: "native-toggle-hook-consumer", status: guard.status, diskUnchanged: true, dirtyEditorRetained: true });
  await palette("Native Settings Consumer");
  await session.poll("document.querySelector('[data-native-settings-consumer]')?.textContent==='native committed message' && !!document.querySelector('[data-native-settings-consumer]').getBoundingClientRect().width");
  assert(await inspect("(()=>{const el=document.querySelector('[data-native-settings-consumer]'),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), "Palette consumer output was not visibly hittable");
  assert(await inspect("document.querySelector('.cm-content')===window.__gpsEditor && document.querySelector('.cm-content').textContent.includes('GPS inline dirty marker')"), "Palette consumer replaced or lost the dirty editor");
  await record({ name: "native-palette-settings-consumer", rendered: "native committed message", sdkSettingsRead: true, sameEditor: true });
  return evidence;
}
