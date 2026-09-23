// WS4 (issue #5 quirk 3): Ctrl+F in source mode opens the in-editor find
// panel (CM6 searches the whole doc, not the viewport DOM); WYSIWYG and
// preview keep native browser find. Esc closes the panel before exiting.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";

const CDP_PORT = Number(process.env.CDP_PORT || 9461);
const vault = await Deno.makeTempDir({ prefix: "ctrlf-vault-" });
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
});
const browser = await launchBrowser({ port: CDP_PORT });
try {
  const page = await connect({ port: CDP_PORT });
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
  await page.poll(`document.querySelector(".rendered-markdown") !== null`);
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
  const revealed = await page.evaluate(`(() => {
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
    process.exit(1);
  }
  console.log("CTRLF OK");
} finally {
  await stopBrowser(browser);
  await server.close();
  Deno.removeSync(vault, { recursive: true });
}
