// Full theme matrix against the published image: every theme must stamp
// inline vars on <html> and toggle body.dark appropriately.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const THEMES = [
  ["globnotes-light", false],
  ["globnotes-dark", true],
  ["dracula", true],
  ["dracula-alucard", false],
  ["catppuccin-latte", false],
  ["catppuccin-frappe", true],
  ["catppuccin-macchiato", true],
  ["catppuccin-mocha", true],
  ["solarized-light", false],
  ["solarized-dark", true],
  ["gruvbox-light", false],
  ["gruvbox-dark", true],
  ["nord", true],
  ["tokyo-night", true],
  ["tokyo-night-light", false],
];

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));

await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(1200);

let failures = 0;
for (const [id, expectDark] of THEMES) {
  const result = await page.evaluate(async (themeId) => {
    const { setTheme } = await import("/_/assets/index.js").catch(() => ({}));
    return null;
  }, id);
  // setTheme via the exposed module is unreliable post-bundle; use the
  // picker-free path: write localStorage and reload? Too slow per theme.
  // Instead call the app's setTheme through the window if exposed; else
  // simulate via localStorage + reload once per theme.
  break;
}

// Simpler robust path: for each theme, set localStorage and reload.
for (const [id, expectDark] of THEMES) {
  await page.evaluate((themeId) => {
    localStorage.setItem("globnotes-theme", themeId);
  }, id);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => ({
    brand: document.documentElement.style
      .getPropertyValue("--theme-brand")
      .trim(),
    dark: document.body.classList.contains("dark"),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  const ok = state.brand !== "" && state.dark === expectDark;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${id}: brand="${state.brand}" dark=${state.dark} bg=${state.bg}`,
  );
}
console.log(failures === 0 ? "ALL THEMES OK" : `${failures} FAILURES`);
console.log("page errors:", errors.length ? errors : "none");
await browser.close();
