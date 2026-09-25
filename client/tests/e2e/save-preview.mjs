// Save from the preview tab (issue: user-reported silent no-op). New note →
// type → Preview tab → Save must create the note with the typed content.
// Pins the unmounted-editor hazard: editor.value is null in preview.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";

const CDP_PORT = Number(process.env.CDP_PORT || 9411);

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
    throw new Error(msg);
  }
  console.log(`ok: ${msg}`);
}

async function fillField(page, selector, value) {
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

let server = null;
let browser = null;
try {
  server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  browser = await launchBrowser({ port: CDP_PORT });
  const page = await connect({ port: CDP_PORT });

  // New note, typed in source mode.
  await page.goto(`${server.baseUrl}/_/new`);
  await page.poll(`document.querySelector(".cm-content, .ProseMirror") !== null`);
  await fillField(page, "input[placeholder=Title]", "PreviewSaved");
  await page.evaluate(`(() => {
    const el = document.querySelector(".cm-content, .ProseMirror");
    el.focus();
    return true;
  })()`);
  await page.send("Input.insertText", { text: "# Saved from preview\n\nbody text\n" });

  // Switch to the preview tab (the editor unmounts) and save there.
  await page.clickText("Preview");
  await page.poll(`document.querySelector(".preview-buffer") !== null`);
  await page.poll(
    `document.querySelector(".preview-buffer").textContent.includes("body text")`,
  );
  console.log("ok: preview shows the unsaved buffer");

  await page.clickText("Save");
  await page.poll(`location.pathname.includes("PreviewSaved")`, {
    timeout: 10000,
  });
  console.log("ok: routed to the new note after save from preview");

  const onDisk = await Deno.readTextFile(`${server.vault}/PreviewSaved.md`);
  assert(onDisk.includes("body text"), "note on disk carries the typed content");

  console.log("SAVE-PREVIEW OK");
} finally {
  if (browser) await stopBrowser(browser);
  if (server) await server.close();
  if (failures > 0) Deno.exit(1);
}
