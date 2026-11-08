// WS4 (issue #5 quirk 3): Ctrl+F in source mode opens the in-editor find
// panel (CM6 searches the whole doc, not the viewport DOM); WYSIWYG and
// preview keep native browser find. Esc closes the panel before exiting.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { applicationServer } from "./http-origin.mjs";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { assert } from "./test-outcomes.mjs";

const CDP_PORT = Number(process.env.CDP_PORT || 9461);
const vault = await Deno.makeTempDir({ prefix: "ctrlf-vault-" });
const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "ctrlf-artifacts-" });
const observations = [], requests = new Map();
const started = performance.now();
let page, failure, initialViewerMs;
const filler = Array.from(
  { length: 200 },
  (_, i) => `Filler paragraph number ${i + 1} with ordinary words.`,
).join("\n\n");
await Deno.writeTextFile(
  `${vault}/long.md`,
  `# Long note\n\n${filler}\n\nThe marker is ZZZFINDME at the very bottom.\n`,
);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok: ${name}`);
  else {
    failures++;
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const server = await bootServer({
  GLOBNOTES_PATH: vault,
  GLOBNOTES_AUTH_TYPE: "none",
  GLOBNOTES_PATH_PREFIX: "",
}, applicationServer());
const browser = await launchBrowser({ port: CDP_PORT });
try {
  page = await connect({ port: CDP_PORT, binding: browser });
  page.onEvent(event => {
    const data = event.params, at = performance.now() - started;
    if (event.method === "Network.requestWillBeSent") {
      const row = { at, url: data.request.url, type: data.type };
      requests.set(data.requestId, row); observations.push({ event: event.method, ...row });
    } else if (event.method === "Network.responseReceived") {
      const row = requests.get(data.requestId);
      if (row) { row.status = data.response.status; row.responseAt = at; }
    } else if (["Network.loadingFinished", "Network.loadingFailed"].includes(event.method)) {
      const row = requests.get(data.requestId);
      if (row) { row.finishedAt = at; row.failure = data.errorText; }
    } else if (["Page.frameNavigated", "Page.navigatedWithinDocument"].includes(event.method)) observations.push({ at, event: event.method, data });
  });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  async function ctrlF() {
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "f", code: "KeyF", modifiers: 2,
      windowsVirtualKeyCode: 70,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "f", code: "KeyF", modifiers: 2,
      windowsVirtualKeyCode: 70,
    });
  }
  const panelOpen =
    `document.querySelector(".cm-panel.cm-search") !== null`;

  // -- Source mode: panel opens, off-screen match found + revealed ---------
  await page.goto(`${server.baseUrl}/long`);
  const viewerStarted = performance.now();
  await page.poll(`document.querySelector(".rendered-markdown") !== null`);
  initialViewerMs = performance.now() - viewerStarted;
  await Deno.writeTextFile(`${artifacts}/initial-viewer.json`, JSON.stringify({ initialViewerMs, observations, requests: [...requests.values()] }, null, 2));
  await page.clickText("Edit");
  await page.poll(`document.querySelector(".cm-host") !== null`);
  // Focus the editor so its keymap sees the key.
  await page.evaluate(`document.querySelector(".cm-content").focus()`);
  await ctrlF();
  await page.poll(panelOpen);
  check("Ctrl+F opens the find panel in source mode", true);

  await page.evaluate(`(() => {
    const input = document.querySelector(".cm-panel.cm-search input");
    input.focus();
  })()`);
  await page.send("Input.insertText", { text: "ZZZFINDME" });
  // CM6's panel commits the query on `change` (not per keystroke); Enter
  // then jumps to the first match like a user's would.
  await page.evaluate(`(() => {
    const input = document.querySelector(".cm-panel.cm-search input");
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.waitForTimeout(300);
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
  });
  await page.waitForTimeout(600);
  // Proof: the scroller moved AND the match renders inside the viewport
  // (CM6 only DOM-renders the visible region, so presence == in view).
   const revealed = await page.read('.cm-scroller', `(() => {
    const scroller = document.querySelector(".cm-scroller");
    const sr = scroller.getBoundingClientRect();
    const hit = [...document.querySelectorAll(".cm-content *")]
      .filter((el) => el.childElementCount === 0)
      .find((el) => {
        if (!el.textContent.includes("ZZZFINDME")) return false;
        const r = el.getBoundingClientRect();
        return r.top >= sr.top && r.bottom <= sr.bottom;
      });
    return { scrollTop: scroller.scrollTop, inView: !!hit };
  })()`);
  check(
    "off-screen match is found and scrolled into view",
    revealed.scrollTop > 0 && revealed.inView,
    JSON.stringify(revealed),
  );

  // Esc closes the panel first (never exits edit while it's open).
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await page.waitForTimeout(300);
  const panelClosed = await page.evaluate(
    `document.querySelector(".cm-panel.cm-search") === null`,
  );
  const stillEditing = await page.evaluate(
    `document.querySelector(".cm-host") !== null`,
  );
  check("Esc closes the panel without exiting edit", panelClosed && stillEditing);

  // -- WYSIWYG: no CM panel -------------------------------------------------
  await page.clickText("WYSIWYG");
  await page.poll(`document.querySelector(".ProseMirror") !== null`);
  await page.evaluate(`document.querySelector(".ProseMirror").focus()`);
  await ctrlF();
  await page.waitForTimeout(400);
  const noPanelWysiwyg = await page.evaluate(
    `document.querySelector(".cm-panel.cm-search") === null`,
  );
  check("WYSIWYG keeps native find (no CM panel)", noPanelWysiwyg);

  // -- Preview: no CM panel --------------------------------------------------
  await page.clickText("Preview");
  await page.poll(`document.querySelector(".preview-buffer") !== null`);
  await ctrlF();
  await page.waitForTimeout(400);
  const noPanelPreview = await page.evaluate(
    `document.querySelector(".cm-panel.cm-search") === null`,
  );
  check("preview keeps native find (no CM panel)", noPanelPreview);

  if (failures > 0) {
    console.log(`CTRLF: ${failures} failure(s)`);
  }
  assert(failures === 0, `CTRLF: ${failures} failure(s)`);
  console.log("CTRLF OK");
} catch (error) {
  failure = error;
  if (page) {
    const snapshot = await page.evaluate("({url:location.href,ready:document.readyState,body:document.body?.innerText,viewer:document.querySelector('.toast-viewer')?.outerHTML,editors:[...document.querySelectorAll('.cm-content,.ProseMirror')].map(el=>el.textContent),resources:performance.getEntriesByType('resource').map(row=>({name:row.name,startTime:row.startTime,duration:row.duration}))})").catch(captureError => ({ captureError: String(captureError) }));
    await Deno.writeTextFile(`${artifacts}/failure.json`, JSON.stringify({ error: String(error), initialViewerMs, elapsedMs: performance.now() - started, snapshot, pageErrors: page.pageErrors, events: page.events, observations, requests: [...requests.values()], server: server.logs() }, null, 2));
    await page.screenshot(`${artifacts}/failure.png`).catch(captureError => console.error("Failure screenshot:", String(captureError)));
  }
  throw error;
} finally {
  await Deno.writeTextFile(`${artifacts}/observations.json`, JSON.stringify({ failed: !!failure, initialViewerMs, elapsedMs: performance.now() - started, observations, requests: [...requests.values()], pageErrors: page?.pageErrors, events: page?.events }, null, 2));
  await stopBrowser(browser);
  await server.close();
  console.log("Retained find fixture", vault);
}
