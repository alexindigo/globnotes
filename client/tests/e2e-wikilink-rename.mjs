// E2E: rename a note through the UI; wikilinks in other notes must update.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";

// Fixture via API
await fetch(`${BASE}/_/api/notes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "probe/link-source", content: "see [[probe/link-target]]" }),
});
await fetch(`${BASE}/_/api/notes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "probe/link-target", content: "# Target" }),
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Open the target note, rename it via the UI title field
await page.goto(`${BASE}/probe/link-target`, { waitUntil: "load" });
await page.waitForTimeout(1500);

// Close the sidebar drawer if it's covering the page
if (await page.evaluate(() => !!document.querySelector("aside"))) {
  await page.click("aside button:has(svg)");
  await page.waitForTimeout(400);
}

await page.click("text=Edit");
await page.waitForTimeout(1000);

// The basename field is the first visible input (title)
const titleInput = page.locator("input:visible").first();
await titleInput.fill("link-target-renamed");
await page.click("text=Save");
await page.waitForTimeout(1500);

const afterUrl = page.url();
console.log("after rename url:", afterUrl);

// Now read the source note and check the rendered link text/href
await page.goto(`${BASE}/probe/link-source`, { waitUntil: "load" });
await page.waitForTimeout(1500);
const link = await page.evaluate(() => {
  const a = [...document.querySelectorAll(".toastui-editor-contents a")].find((x) =>
    x.textContent.includes("link"),
  );
  return a ? { text: a.textContent, href: a.getAttribute("href") } : null;
});
console.log("source link:", JSON.stringify(link));
const content = await page.evaluate(async () => {
  const r = await fetch("/_/api/notes/probe/link-source");
  return (await r.json()).content;
});
console.log("source content:", JSON.stringify(content));
console.log("pageerrors:", errors.length ? errors : "none");
await browser.close();

// Cleanup fixture
await fetch(`${BASE}/_/api/notes/probe/link-source`, { method: "DELETE" });
await fetch(`${BASE}/_/api/notes/probe/link-target-renamed`, { method: "DELETE" });
