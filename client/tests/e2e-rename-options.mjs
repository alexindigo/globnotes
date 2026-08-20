// Test one rename strategy option end-to-end. Usage: node e2e-rename-options.mjs <move|relink|none>
import { chromium } from "playwright";

const OPTION = process.argv[2] || "move";
const TARGET = OPTION === "move" ? "archive-move" : OPTION === "relink" ? "archive-relink" : "archive-none";
const BASE = "http://localhost:8000";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.addInitScript(() => {
  localStorage.setItem("sidebarVisible", "false");
});

await page.goto(`${BASE}/rename-me/moving-note`, { waitUntil: "load" });
await page.waitForTimeout(1500);
const beforeOk = await page.evaluate(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return el ? el.complete && el.naturalWidth > 0 : false;
});

await page.click("text=Edit");
await page.waitForTimeout(1000);
const inputs = page.locator("input:visible");
for (let i = 0; i < (await inputs.count()); i++) {
  const v = await inputs.nth(i).inputValue().catch(() => "");
  if (v === "rename-me") {
    await inputs.nth(i).fill(TARGET);
  }
}
await page.click("text=Save");
await page.waitForTimeout(1500);

const label = {
  move: "Move files with the note",
  relink: "Keep files, fix the links",
  none: "Don't touch anything",
}[OPTION];

const dialogVisible = await page.evaluate((t) =>
  document.body.innerText.includes("Move note with attachments"),
);
await page.click(`text=${label}`);
await page.waitForTimeout(1800);

// The viewer doesn't re-render on prop change (ToastUI reads initialValue
// once at mount) — reload the note page to see the post-move render.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1500);

const after = await page.evaluate(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return {
    url: location.pathname,
    imgLoaded: el ? el.complete && el.naturalWidth > 0 : null,
    imgSrcAttr: el?.getAttribute("src"),
    imgResolved: el?.src,
    pageErrors: null,
  };
});
console.log(
  JSON.stringify({
    option: OPTION,
    target: TARGET,
    beforeOk,
    dialogVisible,
    afterUrl: after.url,
    imgSrcAttr: after.imgSrcAttr,
    imgResolved: after.imgResolved,
    imgLoaded: after.imgLoaded,
    pageErrors: errors.length ? errors : "none",
  }),
);
await browser.close();
