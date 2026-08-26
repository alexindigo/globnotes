// Recent notes section over CDP: the clock in the sidebar bottom row toggles a
// Recent list of the 10 most-recently-modified notes, and section titles
// appear only when more than one section is visible.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const PORT = Number(process.env.CDP_PORT || 9333);

const page = await connect({ port: PORT });
// sidebarVisible resets each load; sidebarRecent is NOT cleared here so the
// Recent toggle can be checked for persistence across a reload.
await page.addInitScript(`localStorage.setItem("sidebarVisible", "false");`);
await page.goto(`${BASE}/rendering/code-blocks`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

const sectionTitles = () => page.evaluate(
  `[...document.querySelectorAll("aside p")].filter((p) => p.textContent.trim() === "Recent" || p.textContent.trim() === "Files").map((p) => p.textContent.trim())`,
);
const recentRowCount = () => page.evaluate(
  `[...document.querySelectorAll("aside a[title]")].filter((a) => !a.getAttribute("title").includes("Open folder")).length`,
);

await page.evaluate(`document.querySelector('button[title="Open sidebar"]')?.click()`);
await page.poll(`document.querySelector("aside") && getComputedStyle(document.querySelector("aside")).display !== "none"`);

// No titles when only Files is visible.
let titles = await sectionTitles();
if (titles.length !== 0) throw new Error("expected no section titles for Files only: " + JSON.stringify(titles));
console.log("files only: no titles ✓");

// Toggle Recent on via the clock in the bottom row.
await page.evaluate(`document.querySelector('button[title="Recent notes"]')?.click()`);
await page.waitForTimeout(800);
titles = await sectionTitles();
const count = await recentRowCount();
const clockAtBottom = await page.evaluate(
  `(() => { const b = document.querySelector('button[title="Recent notes"]'); return b && b.closest("div") && b.closest("div").className.includes("border-t"); })()`,
);
if (titles.length !== 2 || !titles.includes("Recent") || !titles.includes("Files")) {
  throw new Error("expected Recent + Files titles: " + JSON.stringify(titles));
}
if (count !== 5) throw new Error("expected 5 recent rows, got " + count);
if (!clockAtBottom) throw new Error("clock button not in the bottom row");

// Active section button shows a bottom border (tab indicator).
const bottomBorder = await page.evaluate(
  `(() => { const b = document.querySelector('button[title="Recent notes"]'); const cs = getComputedStyle(b); return { style: cs.borderBottomStyle, width: cs.borderBottomWidth }; })()`,
);
if (bottomBorder.style !== "solid" || bottomBorder.width === "0px") {
  throw new Error("expected bottom border on active section button: " + JSON.stringify(bottomBorder));
}
console.log("recent on: titles [Recent, Files], 5 rows, clock in bottom row, bottom border ✓");

// Toggle off again.
await page.evaluate(`document.querySelector('button[title="Recent notes"]')?.click()`);
await page.waitForTimeout(400);
titles = await sectionTitles();
if (titles.length !== 0) throw new Error("expected titles cleared after toggle off: " + JSON.stringify(titles));
console.log("recent off: titles cleared ✓");

// Persist across a reload: reopen the drawer (init script resets it closed)
// and confirm the Recent toggle itself persisted.
await page.evaluate(`document.querySelector('button[title="Recent notes"]')?.click()`);
await page.waitForTimeout(600);
await page.reload();
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await page.evaluate(`document.querySelector('button[title="Open sidebar"]')?.click()`);
await page.poll(`document.querySelector("aside") && getComputedStyle(document.querySelector("aside")).display !== "none"`);
titles = await sectionTitles();
if (titles.length !== 2 || !titles.includes("Recent") || !titles.includes("Files")) {
  throw new Error("expected persisted Recent on reload: " + JSON.stringify(titles));
}
console.log("recent persists across reload ✓");

console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
if (page.pageErrors.length) process.exit(1);
console.log("RECENT FILES OK");
page.close();
process.exit(0);
