// E2E: copy button on code blocks — bottom-right corner, copies the full
// block content to the clipboard.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const browser = await chromium.launch();
const context = await browser.newContext({
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.addInitScript(() => {
  localStorage.setItem("sidebarVisible", "false");
});

await page.goto(`${BASE}/rendering/code-blocks`, { waitUntil: "load" });
await page.waitForTimeout(1500);

const buttons = await page.locator(".code-copy-btn").count();
console.log("copy buttons found:", buttons);

if (buttons > 0) {
  const first = page.locator(".code-copy-btn").first();
  await first.click();
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const ok = clip.includes("def greet");
  console.log("clipboard contains the block:", ok);
  console.log(ok ? "COPY BUTTON OK" : "COPY BUTTON BROKEN");
} else {
  console.log("COPY BUTTON MISSING");
}
console.log("pageerrors:", errors.length ? errors : "none");
await browser.close();
