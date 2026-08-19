// Debug: moving-note image render + rename dialog flow.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// 1. Image render
await page.goto(`${BASE}/rename-me/moving-note`, { waitUntil: "load" });
await page.waitForTimeout(1500);
const img = await page.evaluate(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return el
    ? {
        src: el.getAttribute("src"),
        resolved: el.src,
        loaded: el.complete && el.naturalWidth > 0,
        naturalWidth: el.naturalWidth,
      }
    : null;
});
console.log("image:", JSON.stringify(img, null, 1));

// 2. Rename flow: edit, change folder, save, watch for the dialog
const requests = [];
page.on("request", (r) => {
  if (r.url().includes("rename-preview") || r.url().includes("/api/notes")) {
    requests.push(`${r.method()} ${r.url()}`);
  }
});
page.on("response", async (r) => {
  if (r.url().includes("rename-preview")) {
    console.log("rename-preview ->", r.status(), await r.text().catch(() => ""));
  }
});

// Toggle edit
await page.click('text=Edit');
await page.waitForTimeout(800);

// The folder field is the second input (first is the title/basename)
const inputs = page.locator("input:visible");
const count = await inputs.count();
console.log("visible inputs:", count);
for (let i = 0; i < count; i++) {
  const val = await inputs.nth(i).inputValue().catch(() => null);
  const ph = await inputs.nth(i).getAttribute("placeholder").catch(() => null);
  console.log(`input[${i}] value=${JSON.stringify(val)} placeholder=${JSON.stringify(ph)}`);
}
