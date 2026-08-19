// E2E: rename a note across folders with an attachment -> the dialog
// must appear, and choosing "move" must relocate the image and keep the
// note's image rendering.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Keep the sidebar drawer closed so it doesn't intercept clicks.
await page.addInitScript(() => {
  localStorage.setItem("sidebarVisible", "false");
});

await page.goto(`${BASE}/rename-me/moving-note`, { waitUntil: "load" });
await page.waitForTimeout(1500);

// image renders before the move
const before = await page.evaluate(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return el ? el.complete && el.naturalWidth > 0 : false;
});
console.log("image renders before move:", before);

// Enter edit mode
await page.click("text=Edit");
await page.waitForTimeout(800);

// Change the folder field (second visible input) to 'archive'
const inputs = page.locator("input:visible");
await inputs.nth(1).fill("archive");

// Save
await page.click("text=Save");
await page.waitForTimeout(1200);

// The rename dialog must appear with the three strategy buttons
const dialogState = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    dialogVisible: text.includes("Move note with attachments"),
    hasMove: text.includes("Move files with the note"),
    hasRelink: text.includes("Keep files, fix the links"),
    hasNone: text.includes("Don't touch anything"),
  };
});
console.log("dialog:", JSON.stringify(dialogState));

if (dialogState.dialogVisible) {
  // Choose: move files with the note
  await page.click("text=Move files with the note");
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    url: location.pathname,
    img: (() => {
      const el = document.querySelector(".toastui-editor-contents img");
      return el
        ? { src: el.getAttribute("src"), loaded: el.complete && el.naturalWidth > 0 }
        : null;
    })(),
  }));
  console.log("after move:", JSON.stringify(after));
}
console.log("pageerrors:", errors.length ? errors : "none");
await browser.close();
