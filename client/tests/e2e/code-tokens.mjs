// Code-token theme check over CDP: prism keyword colors follow the theme.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);

// Self-contained fixture
await fetch(`${BASE}/_/api/notes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "code-test",
    content: '# Code\n\n```python\ndef hello():\n    return "world"\n```',
  }),
}).catch(() => null);

const page = await connect({ port: PORT });

async function tokenColor() {
  await page.goto(`${BASE}/code-test`);
  await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
  return page.evaluate(`(() => {
    const el = document.querySelector(".toastui-editor-contents .token.keyword, .toastui-editor-contents .token.function");
    return el ? getComputedStyle(el).color : null;
  })()`);
}

const colorDefault = await tokenColor();
await page.evaluate(`localStorage.setItem("globnotes-theme", "tokyo-night")`);
await page.reload();
await page.waitForTimeout(500);
const c1 = await tokenColor();
await page.evaluate(`localStorage.setItem("globnotes-theme", "dracula")`);
await page.reload();
await page.waitForTimeout(500);
const c2 = await tokenColor();
await page.evaluate(`localStorage.setItem("globnotes-theme", "catppuccin-latte")`);
await page.reload();
await page.waitForTimeout(500);
const c3 = await tokenColor();

console.log("default:", colorDefault);
console.log("tokyo-night:", c1);
console.log("dracula:", c2);
console.log("catppuccin-latte:", c3);
const distinct = new Set([c1, c2, c3].filter(Boolean)).size;
console.log(distinct >= 2 && c1 && c2 && c3 ? "CODE TOKENS FOLLOW THEME: OK" : "CODE TOKENS BROKEN");
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
page.close();
process.exit(distinct >= 2 ? 0 : 1);
