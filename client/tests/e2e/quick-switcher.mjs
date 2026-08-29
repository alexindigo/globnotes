// Quick switcher over CDP: menu button → fuzzy match a note → navigate.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const PORT = Number(process.env.CDP_PORT || 9333);

const page = await connect({ port: PORT });
await page.goto(`${BASE}/rendering/code-blocks`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

// Open the corner menu and choose "Quick switcher".
await page.click('button[title="Menu"]');
await page.poll(`[...document.querySelectorAll("a")].some((a) => a.textContent.includes("Quick switcher"))`);
await page.evaluate(`(() => { const el=[...document.querySelectorAll("a")].find((a)=>a.textContent.includes("Quick switcher")); el.click(); })()`);
await page.poll(`document.querySelector('input[placeholder="Switch to note…"]') !== null`);

// Empty query: the note we just opened is the recently-opened top row.
const emptyTop = await page.evaluate(
  `document.querySelector("ul li span") ? document.querySelector("ul li span").textContent.trim() : ""`,
);
if (emptyTop.length === 0) throw new Error("empty query shows no recently-opened rows");

// Fuzzy-match "math" → the rendering/math note by display title.
await page.evaluate(`(() => {
  const i = document.querySelector('input[placeholder="Switch to note…"]');
  i.value = "math";
  i.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await page.waitForTimeout(300);
const matches = await page.evaluate(
  `[...document.querySelectorAll("ul li span")].map((s) => s.textContent.trim())`,
);
const hasMath = matches.some((m) => m.toLowerCase().includes("math"));
if (!hasMath) throw new Error("no 'math' match: " + JSON.stringify(matches));
console.log("math match:", JSON.stringify(matches.slice(0, 3)));

// Enter opens the top match.
await page.evaluate(`(() => {
  const i = document.querySelector('input[placeholder="Switch to note…"]');
  i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
})()`);
await page.waitForTimeout(600);
const url = await page.evaluate("location.pathname");
if (!url.includes("math")) throw new Error("did not navigate to a math note: " + url);

console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
if (page.pageErrors.length) process.exit(1);
console.log("QUICK SWITCHER OK");
page.close();
process.exit(0);
