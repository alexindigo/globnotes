// Walk the Next-link chain from readme to the end, verifying each hop
// lands on the expected note.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const CHAIN = [
  "readme",
  "rendering/code-blocks",
  "rendering/math",
  "rendering/callouts",
  "rendering/highlights",
  "rendering/mermaid",
  "rendering/frontmatter",
  "links/wiki-links",
  "links/embeds",
  "folders/dad/recipes/soup",
  "folders/mom/ideas",
  "rename-me/moving-note",
];

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

let current = "readme";
let hops = 0;
let broken = null;

await page.goto(`${BASE}/readme`, { waitUntil: "load" });
await page.waitForTimeout(1200);

// Close the sidebar drawer (open by default on desktop) so its backdrop
// doesn't intercept content clicks — as a user would.
if (await page.evaluate(() => !!document.querySelector("aside"))) {
  await page.click("aside button:has(svg)");
  await page.waitForTimeout(400);
}

while (hops < CHAIN.length) {
  const expected = CHAIN[hops + 1];
  const pageTitle = await page
    .evaluate(() => document.querySelector(".text-3xl")?.textContent?.trim())
    .catch(() => null);
  if (hops === 0 && !pageTitle) {
    broken = CHAIN[0];
    break;
  }
  if (!expected) {
    break;
  }
  // Click the Next link (wikilink href is the note path)
  const next = page.locator(`.toastui-editor-contents a[href="/${expected}"]`);
  const found = (await next.count()) > 0;
  if (!found) {
    broken = current;
    break;
  }
  await next.first().click();
  await page.waitForTimeout(1000);
  current = await page.evaluate(() => location.pathname.replace(/^\//, ""));
  hops++;
  if (current !== expected) {
    broken = current;
    break;
  }
}

console.log(
  broken
    ? `CHAIN BROKEN at ${current} (hop ${hops})`
    : `CHAIN COMPLETE: ${hops} hops, ended at ${current}`,
);
console.log("pageerrors:", errors.length ? errors : "none");
await browser.close();
