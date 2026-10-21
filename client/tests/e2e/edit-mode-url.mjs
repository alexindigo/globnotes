// Edit-mode URL fragment over CDP: entering/switching/exiting edit syncs
// #edit / #source[:Ln]; deep links open the note in the matching edit mode;
// unknown fragments stay in view mode and leave the URL untouched.
import { runCase } from "./legacy-fixture.mjs";

export async function exercise({ page, baseUrl: BASE }) {
const NOTE = `${BASE}/rendering/code-blocks`;

async function closeDrawer() {
  const drawerOpen = await page.evaluate(`(() => {
    const a = document.querySelector("aside");
    return a && getComputedStyle(a).display !== "none";
  })()`);
  if (drawerOpen) {
    await page.evaluate(`document.querySelector('aside button[title="Close sidebar"]')?.click()`);
    await page.poll(`getComputedStyle(document.querySelector("aside")).display === "none"`);
  }
}

function fail(message) {
  throw new Error(message);
}

// 1. View mode: no fragment.
await page.goto(NOTE);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await closeDrawer();
if ((await page.evaluate(`location.hash`)) !== "") {
  fail("expected empty fragment in view mode");
}

// 2. Enter edit -> #source (fresh profile defaults to markdown mode).
await page.clickText("Edit");
await page.poll(`!!document.querySelector(".cm-editor")`);
await page.poll(`location.hash === "#source"`);

// 3. Caret move -> line aspect appears.
await page.click(".cm-content");
await page.key("Home", { modifiers: 2, windowsVirtualKeyCode: 36 });
await page.key("ArrowRight", { windowsVirtualKeyCode: 39 });
const sourceText = () => page.evaluate(`[...document.querySelectorAll('.cm-content .cm-line')].map(el => el.textContent).join('\\n')`);
const beforeCaretWrite = await sourceText();
await page.poll(`/^#source:L\\d+/.test(location.hash)`);
await page.waitForTimeout(650);
const caretAfterWrite = await page.evaluate(`({ collapsed: getSelection().isCollapsed, selected: getSelection().toString(), hash: location.hash })`);
await page.send("Input.insertText", { text: "caret-probe" });
await page.poll(`document.querySelector('.cm-content').textContent.includes('caret-probe')`);
const afterCaretType = await sourceText();
if (!caretAfterWrite.collapsed || !(await page.evaluate(`getSelection().isCollapsed`)) ||
    afterCaretType !== beforeCaretWrite.slice(0, 1) + "caret-probe" + beforeCaretWrite.slice(1)) {
  fail("own caret URL write selected or deleted text: " + JSON.stringify({ caretAfterWrite, beforeCaretWrite, afterCaretType }));
}
// Native undo returns the original clean buffer before exercising exit/history.
await page.key("z", { modifiers: 2, code: "KeyZ", windowsVirtualKeyCode: 90 });
await page.poll(`[...document.querySelectorAll('.cm-content .cm-line')].map(el => el.textContent).join('\\n') === ${JSON.stringify(beforeCaretWrite)}`);

// 4. Toggle edit off from this clean session -> fragment cleared.
// (Done before any WYSIWYG round-trip: a mode switch normalizes content,
// which correctly trips the save-changes modal on close.)
await page.clickText("Edit");
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await page.poll(`location.hash === ""`);

// 5. #edit deep link lands in WYSIWYG without clicking anything; the
// mode switch then moves the fragment to #source.
await page.goto(`${BASE}/`);
await page.goto(`${NOTE}#edit`);
await page.poll(`!!document.querySelector(".ProseMirror")`, { timeout: 15000 });
await page.poll(`location.hash === "#edit"`);
await page.clickText("Source");
await page.poll(`!!document.querySelector(".cm-editor")`, { timeout: 15000 });
await page.poll(`location.hash === "#source"`);

// 6. #source:L2-4 lands in source mode; fragment preserved.
await page.goto(`${BASE}/`);
await page.goto(`${NOTE}#source:L2-4`);
await page.poll(`!!document.querySelector(".cm-editor")`, { timeout: 15000 });
await page.poll(`/^#source:L2(-4)?$/.test(location.hash)`);
// A deep-linked editor starts unfocused; focus exposes its stored range to
// the browser Selection API without moving the caret as a click would.
await page.evaluate(`document.querySelector('.cm-content').focus()`);
await page.poll(`getSelection().toString() === [...document.querySelectorAll('.cm-content .cm-line')].slice(1, 4).map(el => el.textContent).join('\\n')`);

// 7. Unknown fragment (#L3) stays in view mode, URL untouched.
await page.goto(`${BASE}/`);
await page.goto(`${NOTE}#L3`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
const unknown = await page.evaluate(`({
  hash: location.hash,
  editor: !!document.querySelector(".cm-editor, .ProseMirror"),
})`);
if (unknown.hash !== "#L3" || unknown.editor) {
  fail("unknown fragment leaked into edit mode: " + JSON.stringify(unknown));
}

// 8. History stack: enter-edit and mode switches push entries, so the
// back button walks them; caret sync replaced, so one back step doesn't
// replay every keystroke.
await page.goto(`${BASE}/`);
await page.goto(NOTE);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await page.clickText("Edit");
await page.poll(`!!document.querySelector(".cm-editor")`);
await page.evaluate(`history.back()`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await page.poll(`location.hash === ""`);
await page.evaluate(`history.forward()`);
await page.poll(`!!document.querySelector(".cm-editor")`);
await page.click(".cm-content");
await page.key("Home", { modifiers: 2, windowsVirtualKeyCode: 36 });
await page.key("ArrowRight", { windowsVirtualKeyCode: 39 });
await page.poll(`location.hash === '#source:L1'`);
await page.waitForTimeout(250);
if (!(await page.evaluate(`getSelection().isCollapsed`))) fail("history entry publication selected the caret line");
await page.clickText("WYSIWYG");
await page.poll(`!!document.querySelector(".ProseMirror")`, { timeout: 15000 });
await page.evaluate(`history.back()`);
await page.poll(`!!document.querySelector(".cm-editor")`, { timeout: 15000 });
await page.poll(`/^#source/.test(location.hash)`);
await page.evaluate(`document.querySelector('.cm-content').focus()`);
await page.poll(`getSelection().toString() === document.querySelector('.cm-content .cm-line').textContent`);

// 9. Same-document fragment changes (pasting a link into an open tab)
// are reconciled without a reload: view -> source, source -> edit,
// edit -> source with a new line range.
await page.goto(`${BASE}/`);
await page.goto(NOTE);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await page.goto(`${NOTE}#source:L2-4`);
await page.poll(`!!document.querySelector(".cm-editor")`);
await page.goto(`${NOTE}#edit`);
await page.poll(`!!document.querySelector(".ProseMirror")`, { timeout: 15000 });
await page.goto(`${NOTE}#source:L3`);
await page.poll(`!!document.querySelector(".cm-editor")`, { timeout: 15000 });
await page.poll(`/^#source:L3/.test(location.hash)`);
await page.evaluate(`document.querySelector('.cm-content').focus()`);
await page.poll(`getSelection().toString() === document.querySelectorAll('.cm-content .cm-line')[2].textContent`);

// 10. SPA-navigating to a different note while editing: the edit session
// ends with the URL — no fragment, viewer shown, editor gone. Opening the
// drawer populates the note tree lazily; its RouterLinks are at App level.
await page.goto(`${BASE}/`);
await page.goto(NOTE);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await page.clickText("Edit");
await page.poll(`!!document.querySelector(".cm-editor")`);
await page.click('button[title="Open sidebar"]');
await page.poll(
  `[...document.querySelectorAll("aside a[href]")].some((a) => a.getAttribute("href") === "/readme")`,
);
const clickedAway = await page.evaluate(`(() => {
  const link = [...document.querySelectorAll("aside a[href]")].find(
    (a) => a.getAttribute("href") === "/readme",
  );
  if (!link) return false;
  link.click();
  return true;
})()`);
if (!clickedAway) fail("sidebar note link not found");
await page.poll(`location.pathname === "/readme"`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
const away = await page.evaluate(`({
  hash: location.hash,
  viewer: !!document.querySelector(".toastui-editor-contents"),
  editor: !!document.querySelector(".cm-editor, .ProseMirror"),
})`);
if (away.hash !== "" || !away.viewer || away.editor) {
  fail("navigating away left edit state behind: " + JSON.stringify(away));
}

// Click a modal button by label via a real DOM click (CDP coordinate clicks
// land on the modal body, which overlaps the buttons' hit area).
async function clickModalButton(label) {
  const ok = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll("button")].filter((e) => e.offsetParent !== null)
      .find((e) => e.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!ok) fail(`modal button not found: ${label}`);
}

// 11. Dirty SPA-navigation is gated: the Save Changes modal blocks the
// transition; Discard lets it proceed without persisting the work.
await page.goto(NOTE);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await closeDrawer();
await page.clickText("Edit");
await page.poll(`!!document.querySelector(".cm-editor")`);
await page.click(".cm-content");
await page.send("Input.insertText", { text: "gate-discard" });
await page.waitForTimeout(300);
await page.click('button[title="Open sidebar"]');
await page.poll(
  `[...document.querySelectorAll("aside a[href]")].some((a) => a.getAttribute("href") === "/readme")`,
);
const clickedAway2 = await page.evaluate(`(() => {
  const link = [...document.querySelectorAll("aside a[href]")].find(
    (a) => a.getAttribute("href") === "/readme",
  );
  link?.click();
  return !!link;
})()`);
if (!clickedAway2) fail("sidebar note link not found (gate case)");
await page.poll(`document.body.innerText.includes("Save Changes")`, { timeout: 10000 });
await clickModalButton("Discard");
await page.poll(`location.pathname === "/readme"`, { timeout: 10000 });
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
const gateAway = await page.evaluate(`({
  hash: location.hash,
  editor: !!document.querySelector(".cm-editor, .ProseMirror"),
  persisted: null,
})`);
gateAway.persisted = await page.evaluate(
  `fetch(${JSON.stringify("/_/api/notes/rendering/code-blocks")}).then(r=>r.json()).then(j=>j.content.includes("gate-discard"))`,
);
if (gateAway.hash !== "" || gateAway.editor || gateAway.persisted) {
  fail("gated navigation leaked edit state or work: " + JSON.stringify(gateAway));
}

// 12. The back-button contract: a dirty back is held by the modal — the URL
// does not change until Save/Discard, and Cancel stays in the edit page with
// the URL untouched.
await page.goto(NOTE);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await closeDrawer();
await page.clickText("Edit");
await page.poll(`!!document.querySelector(".cm-editor")`);
await page.click(".cm-content");
await page.send("Input.insertText", { text: "back-held" });
await page.waitForTimeout(300);
const urlWhileEditing = await page.evaluate(`location.href`);
await page.evaluate(`history.back()`);
await page.poll(`document.body.innerText.includes("Save Changes")`, { timeout: 10000 });
if ((await page.evaluate(`location.href`)) !== urlWhileEditing) {
  fail("URL changed while the save modal was open");
}
await clickModalButton("Cancel");
await page.waitForTimeout(400);
const afterCancel = await page.evaluate(`({
  href: location.href,
  editor: !!document.querySelector(".cm-editor"),
})`);
if (afterCancel.href !== urlWhileEditing || !afterCancel.editor) {
  fail("Cancel did not hold the edit page/URL: " + JSON.stringify(afterCancel));
}
await page.evaluate(`history.back()`);
await page.poll(`document.body.innerText.includes("Save Changes")`, { timeout: 10000 });
await clickModalButton("Discard");
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`, { timeout: 10000 });
const afterDiscard = await page.evaluate(`({
  hash: location.hash,
  viewer: !!document.querySelector(".toastui-editor-contents"),
  editor: !!document.querySelector(".cm-editor"),
})`);
if (afterDiscard.hash !== "" || !afterDiscard.viewer || afterDiscard.editor) {
  fail("Discard after back left edit state: " + JSON.stringify(afterDiscard));
}

// 13. Regression: a stored draft resumed + a dirty back must NOT double-prompt
// (Draft Detected AND Save Changes). Pop-driven transitions are owned by the
// route guard; the hashchange listener must not also fire them.
await page.goto(NOTE);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await closeDrawer();
await page.evaluate(`sessionStorage.setItem("rendering/code-blocks", "# stored draft")`);
await page.clickText("Edit");
await page.poll(`document.body.innerText.includes("Draft Detected")`, { timeout: 10000 });
await clickModalButton("Resume Draft");
await page.poll(`!!document.querySelector(".cm-editor")`, { timeout: 10000 });
await page.click(".cm-content");
await page.send("Input.insertText", { text: "more" });
await page.waitForTimeout(300);
await page.evaluate(`history.back()`);
await page.poll(`document.body.innerText.includes("Save Changes")`, { timeout: 10000 });
const noDouble = await page.evaluate(`({
  save: document.body.innerText.includes("Save Changes"),
  draft: document.body.innerText.includes("Draft Detected"),
})`);
if (!noDouble.save || noDouble.draft) {
  fail("double modal on dirty back with resumed draft: " + JSON.stringify(noDouble));
}
// Resolve the modal cleanly (discard) so the next case starts clean.
await clickModalButton("Discard");
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`, { timeout: 10000 });

console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
if (page.pageErrors.length) fail("page errors present");
console.log("EDIT MODE URL OK");
return { editFragments: true, caretTextPreserved: true, history: true, dirtyNavigation: true, noDuplicateDraftPrompt: true };
}
if (import.meta.main) await runCase("edit-mode-url", exercise);
