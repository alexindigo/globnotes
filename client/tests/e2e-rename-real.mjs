// Real-flow rename test: fresh browser, no localStorage tricks.
// If the drawer is open on load (desktop default), close it via its
// close button first — the way a user would.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/rename-me/moving-note`, { waitUntil: "load" });
await page.waitForTimeout(2000);

// Note state + image
const note = await page.evaluate(() => ({
  title: document.querySelector(".text-3xl")?.textContent,
  imgOk: (() => {
    const el = document.querySelector(".toastui-editor-contents img");
    return el ? el.complete && el.naturalWidth > 0 : false;
  })(),
}));
console.log("note state:", JSON.stringify(note));

// Is the drawer open? Close it via its close button if so.
const drawerOpen = await page.evaluate(() =>
  !!document.querySelector("aside"),
);
console.log("drawer open on load:", drawerOpen);
if (drawerOpen) {
  await page.click("aside button[title='Close'], aside button:has(svg)").catch(() => null);
  await page.waitForTimeout(400);
}

// Edit
await page.click("text=Edit");
await page.waitForTimeout(1000);

// Folder field = the input currently holding 'rename-me'
const inputs = page.locator("input:visible");
const n = await inputs.count();
let folderInput = null;
for (let i = 0; i < n; i++) {
  const v = await inputs.nth(i).inputValue().catch(() => "");
  if (v === "rename-me") folderInput = inputs.nth(i);
}
console.log("folder input found:", !!folderInput);
await folderInput.fill("archive");

await page.click("text=Save");
await page.waitForTimeout(1500);

const dialog = await page.evaluate(() => ({
  visible: document.body.innerText.includes("Move note with attachments"),
  move: document.body.innerText.includes("Move files with the note"),
  relink: document.body.innerText.includes("Keep files, fix the links"),
  none: document.body.innerText.includes("Don't touch anything"),
}));
console.log("dialog:", JSON.stringify(dialog));

if (dialog.visible) {
  await page.click("text=Move files with the note");
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    url: location.pathname,
    imgOk: (() => {
      const el = document.querySelector(".toastui-editor-contents img");
      return el ? el.complete && el.naturalWidth > 0 : false;
    })(),
  }));
  console.log("after move:", JSON.stringify(after));
}
console.log("pageerrors:", errors.length ? errors : "none");
await browser.close();
