// Verify overall page theme across real UI surfaces: navbar, sidebar,
// buttons, text, borders — sampled under multiple themes.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));

async function sample() {
  return page.evaluate(() => {
    const pick = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      navBg: pick("nav", "backgroundColor"),
      brandText: pick("header .text-theme-brand, .text-theme-brand", "color"),
      bodyText: pick("body", "color"),
      buttonBg: pick("button", "backgroundColor"),
      sidebarBg: pick("aside", "backgroundColor"),
      borderColor: pick("hr", "borderTopColor") || pick("*", "borderTopColor"),
    };
  });
}

async function setTheme(id) {
  await page.evaluate((themeId) => {
    localStorage.setItem("globnotes-theme", themeId);
  }, id);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(600);
}

await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(1200);

const results = {};
for (const id of ["globnotes-light", "globnotes-dark", "dracula", "catppuccin-latte"]) {
  await setTheme(id);
  results[id] = await sample();
  console.log(`--- ${id} ---`);
  console.log(JSON.stringify(results[id], null, 1));
}

// Every theme should differ from the others on body bg + nav bg at least.
const bgs = new Set(Object.values(results).map((r) => r.bodyBg));
const navs = new Set(Object.values(results).map((r) => r.navBg));
console.log("distinct body bgs:", bgs.size, "distinct nav bgs:", navs.size);
console.log("page errors:", errors.length ? errors : "none");
await browser.close();
