// Note naming flow: new note's filename follows the first H1 while the
// title field is untouched; a manual title edit stops the follow; the tab
// shows the title live; the sidebar shows the filename after save.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { applicationServer } from "./http-origin.mjs";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { finalizeNativeCase } from "./native-case-finalization.mjs";

const CDP_PORT = Number(process.env.CDP_PORT || 9413);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    throw new Error(msg);
  }
  console.log(`ok: ${msg}`);
}

let server = null;
let browser = null;
let failure;
try {
  server = await bootServer({ fixtureAuth: { auth_type: "none" } }, applicationServer());
  browser = await launchBrowser({ port: CDP_PORT });
  const page = await connect({ port: CDP_PORT, binding: browser });

  // New note: the title field starts Untitled; typing an H1 moves it.
  await page.goto(`${server.baseUrl}/_/new`);
  await page.poll(`document.querySelector(".cm-content, .ProseMirror") !== null`);
   const initial = await page.read('input[placeholder=Title]',
    `document.querySelector("input[placeholder=Title]").value`,
  );
  assert(initial === "Untitled", `title field starts Untitled (got "${initial}")`);

  await page.evaluate(`(() => {
    const el = document.querySelector(".cm-content, .ProseMirror");
    el.focus();
    return true;
  })()`);
  await page.send("Input.insertText", { text: "# Hello World\n\nbody\n" });
  await page.poll(
     `document.querySelector("input[placeholder=Title]")?.value === "Hello World"`,
    { timeout: 8000 },
  );
  console.log("ok: filename follows the first H1");
  await page.poll(`document.title.includes("Hello World")`);
  console.log("ok: the tab shows the title live");

  // A manual title edit stops the follow.
  await page.evaluate(`(() => {
    const el = document.querySelector("input[placeholder=Title]");
    el.value = "My Note";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);
  await page.evaluate(`(() => {
    const el = document.querySelector(".cm-content, .ProseMirror");
    el.focus();
    return true;
  })()`);
  await page.send("Input.insertText", { text: "more text\n" });
  await page.waitForTimeout(600);
   const held = await page.read('input[placeholder=Title]',
    `document.querySelector("input[placeholder=Title]").value`,
  );
  assert(held === "My Note", `touched title stops following (got "${held}")`);

  // Save: the file lands with the held name; the sidebar lists the
  // filename; the tab keeps the title.
  await page.clickText("Save");
  await page.poll(`location.pathname.includes("My%20Note") || location.pathname.includes("My Note")`, {
    timeout: 10000,
  });
  const onDisk = await Deno.readTextFile(`${server.vault}/My Note.md`);
  assert(onDisk.includes("Hello World"), "the file saved with the held name");
  console.log("ok: save lands the file as My Note.md");

  const sidebarText = await page.evaluate(
    `document.querySelector("aside")?.textContent ?? ""`,
  );
  assert(sidebarText.includes("My Note"), "sidebar shows the filename");

  console.log("NOTE-NAMING OK");
} catch (error) {
  failure = error;
  throw error;
} finally {
  await finalizeNativeCase({ error: failure, cleanup: [() => browser && stopBrowser(browser), () => server?.close()] });
}
