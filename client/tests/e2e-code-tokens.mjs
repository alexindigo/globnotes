// Verify code-token colors follow the theme (--theme-code-* vars).
import { chromium } from "playwright";

const BASE = "http://localhost:8400";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));

async function tokenColor() {
  await page.goto(`${BASE}/code-test`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const el = document.querySelector(
      ".toast-viewer .token.keyword, .toast-viewer .token.function",
    );
    return el ? getComputedStyle(el).color : null;
  });
}

async function setTheme(id) {
  await page.evaluate((themeId) => {
    localStorage.setItem("globnotes-theme", themeId);
  }, id);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(400);
}

const colorTokyo = await tokenColor();
await setTheme("tokyo-night");
const c1 = await tokenColor();
await setTheme("dracula");
const c2 = await tokenColor();
await setTheme("catppuccin-latte");
const c3 = await tokenColor();

console.log("default:", colorTokyo);
console.log("tokyo-night:", c1);
console.log("dracula:", c2);
console.log("catppuccin-latte:", c3);
const distinct = new Set([c1, c2, c3].filter(Boolean)).size;
console.log(
  distinct >= 2 && c1 && c2 && c3
    ? "CODE TOKENS FOLLOW THEME: OK"
    : "CODE TOKENS BROKEN",
);
console.log("page errors:", errors.length ? errors : "none");
await browser.close();
