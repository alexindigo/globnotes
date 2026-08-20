// Full theme matrix over CDP: every theme stamps inline vars on <html> and
// toggles body.dark appropriately.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);
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

const page = await connect({ port: PORT });
await page.goto(BASE);
await page.poll(`document.readyState === "complete"`);

let failures = 0;
for (const [id, expectDark] of THEMES) {
  await page.evaluate(
    `localStorage.setItem("globnotes-theme", ${JSON.stringify(id)})`,
  );
  await page.reload();
  await page.waitForTimeout(500);
  const state = await page.evaluate(`({
    brand: document.documentElement.style.getPropertyValue("--theme-brand").trim(),
    dark: document.body.classList.contains("dark"),
    bg: getComputedStyle(document.body).backgroundColor,
  })`);
  const ok = state.brand !== "" && state.dark === expectDark;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${id}: brand="${state.brand}" dark=${state.dark} bg=${state.bg}`,
  );
}
console.log(failures === 0 ? "ALL THEMES OK" : `${failures} FAILURES`);
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
page.close();
process.exit(failures ? 1 : 0);
