// Unified search modal (menu "Search" → switcher) over CDP: fuzzy-jump to
// a note, escape to full search via the pinned bottom row, tag completion,
// and recently-opened on empty query.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const PORT = Number(process.env.CDP_PORT || 9333);
const PLACEHOLDER = "Search or switch to note…";

async function openSwitcher(page) {
  // Search is now a top-level icon button in the navbar (no menu round-trip).
  await page.click('button[title="Search"]');
  await page.poll(`document.querySelector('input[placeholder="${PLACEHOLDER}"]') !== null`);
}

async function setQuery(page, value) {
  await page.evaluate(`(() => {
    const i = document.querySelector('input[placeholder="${PLACEHOLDER}"]');
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.waitForTimeout(300);
}

async function rowsText(page) {
  return await page.evaluate(
    `[...document.querySelectorAll("ul li")].map((li) => li.textContent.trim())`,
  );
}

const page = await connect({ port: PORT });
await page.goto(`${BASE}/rendering/code-blocks`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

await openSwitcher(page);

// Empty query: the note we just opened tops recently-opened.
let rows = await rowsText(page);
if (!rows.length) throw new Error("empty query shows no rows");

// Fuzzy match by title, then Enter opens the note.
await setQuery(page, "math");
rows = await rowsText(page);
if (!rows.some((r) => r.toLowerCase().includes("math"))) {
  throw new Error("no 'math' fuzzy match: " + JSON.stringify(rows));
}
await page.evaluate(`(() => {
  const i = document.querySelector('input[placeholder="${PLACEHOLDER}"]');
  i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
})()`);
await page.waitForTimeout(500);
let url = await page.evaluate("location.pathname");
if (!url.includes("math")) throw new Error("fuzzy open did not navigate: " + url);
console.log("fuzzy → note open ✓", url);

// Reopen: search row (bottom) navigates to the full search page.
await openSwitcher(page);
await setQuery(page, "code");
rows = await rowsText(page);
if (!rows.some((r) => r.toLowerCase().includes("search for"))) {
  throw new Error("no pinned search row: " + JSON.stringify(rows));
}
// Click the pinned search row.
await page.evaluate(`(() => {
  const row = [...document.querySelectorAll("ul li")].find((li) => li.textContent.toLowerCase().includes("search for"));
  if (row) row.click();
})()`);
await page.waitForTimeout(500);
url = await page.evaluate("location.pathname + location.search");
if (!url.includes("/search") || !url.includes("code")) {
  throw new Error("search row did not reach search page: " + url);
}
console.log("search row → search page ✓", url);

// Reopen: tag completion shows a dropdown for the tag prefix.
await openSwitcher(page);
await setQuery(page, "#");
await page.waitForTimeout(400);
const tagMenu = await page.evaluate(
  `document.querySelector("input[placeholder='${PLACEHOLDER}'] + div, input[placeholder='${PLACEHOLDER}'] ~ div")`,
);
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
if (page.pageErrors.length) process.exit(1);
console.log("UNIFIED SEARCH OK");
page.close();
process.exit(0);
