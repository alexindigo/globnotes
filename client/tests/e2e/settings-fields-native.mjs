// Native declarative controls and existing host note/tree choices.
import { chooseNativeColor } from "./native-color-picker.mjs";
export async function exerciseSettingsFields({ session, readSettings, replace }) {
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const start = await readSettings();
  assert(await session.evaluate("document.querySelector('[data-modal-top=true]').textContent.includes('Host path choices')"), "Declared groups/help did not reach the real page");
  await session.button("Choose folder");
  await session.poll("document.querySelector('#settings-path-title')?.textContent.includes('folder')");
  await session.button("Chosen/", '[data-modal-top="true"]');
  await session.button("Use this folder", '[data-modal-top="true"]');
  await session.poll("!document.querySelector('#settings-path-title') && document.querySelector('#settings-field-folder')?.value==='Chosen'");
  await session.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.folder==='Chosen')");
  await session.button("Choose file");
  await session.poll("document.querySelector('#settings-path-title')?.textContent.includes('file')");
  await session.button("Chosen/", '[data-modal-top="true"]');
  await session.button("Inside.md", '[data-modal-top="true"]');
  await session.poll("!document.querySelector('#settings-path-title') && document.querySelector('#settings-field-file')?.value==='Chosen/Inside.md'");
  await session.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.file==='Chosen/Inside.md')");

  await session.click("#settings-field-choice");
  await session.key("ArrowDown", { windowsVirtualKeyCode: 40 });
  await session.key("Enter", { windowsVirtualKeyCode: 13 });
  await session.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.choice===true)");
  const selected = await readSettings();
  assert(typeof selected.values.choice === "boolean", "Select persisted a string instead of its declared boolean primitive");
  assert(await session.evaluate("document.querySelector('#settings-field-color')?.value==='#aabbcc'"), "Conditional color control/default did not render after the typed select");
  await chooseNativeColor(session, "#settings-field-color", "#aabbcc");
  await session.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.color!=='#aabbcc')");
  const color = (await readSettings()).values.color;
  assert(/^#[a-f0-9]{6}$/.test(color) && color !== "#aabbcc", "Native color picker did not persist a selected color");

  await replace("#settings-field-notes", "Native line A");
  const beforeEnter = await readSettings();
  // Native textarea editing needs Enter's character event, as in FIFO's
  // focused-button activation; the shared shortcut-only helper stays intact.
  for (const type of ["keyDown", "keyUp"]) await session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  await session.type("Native line B");
  await session.poll("document.querySelector('#settings-field-notes').value==='Native line A\\nNative line B'");
  assert((await readSettings()).revision === beforeEnter.revision, "Ordinary textarea Enter committed instead of inserting a newline");
  await session.key("Enter", { modifiers: 2, windowsVirtualKeyCode: 13 });
  await session.poll("fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.notes==='Native line A\\nNative line B')");
  await session.click("#settings-field-level");
  await session.key("ArrowRight", { windowsVirtualKeyCode: 39 });
  const level = await session.evaluate("Number(document.querySelector('#settings-field-level').value)");
  assert(level !== 5 && Number.isFinite(level), "Native slider did not change its numeric value");
  await session.click("#settings-field-message");
  await session.poll(`fetch('/_/api/plugin-host/session-guard/settings/preferences').then(r=>r.json()).then(d=>d.values.level===${level})`);
  const final = await readSettings();
  assert(final.values.folder === "Chosen" && final.values.file === "Chosen/Inside.md", "Later field commits crossed or erased captured host-path identities");
  assert(final.values.notes === "Native line A\nNative line B" && final.values.choice === true && final.values.level === level, "Typed controls did not persist their actual consumer values");
  assert(final.revision > start.revision, "Native controls never reached the revisioned settings store");
  assert(await session.evaluate("document.querySelector('.cm-content')===window.__gpsEditor && document.querySelector('.cm-content').textContent.includes('GPS inline dirty marker')"), "Native fields/chooser replaced or lost the dirty editor");
  return { name: "native-typed-controls-and-host-paths", values: final.values, revision: final.revision,
    actualTreeChoices: true, typedBooleanSelect: true, nativeSlider: true, textareaNewlineAndModEnter: true,
    colorDefaultAndConditionalRendering: true, nativeColorSelection: color, dirtyEditorRetained: true };
}
