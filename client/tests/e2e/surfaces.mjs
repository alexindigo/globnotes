// Surface theme check over CDP: navbar/sidebar/text/borders follow the theme.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);

const page = await connect({ port: PORT });
await page.goto(BASE);
await page.waitForTimeout(1200);

const SAMPLE = `({
  bodyBg: getComputedStyle(document.body).backgroundColor,
  navBg: getComputedStyle(document.querySelector("nav")).backgroundColor,
  bodyText: getComputedStyle(document.body).color,
  buttonBg: getComputedStyle(document.querySelector("button")).backgroundColor,
  borderColor: getComputedStyle(document.querySelector("hr") || document.body).borderTopColor,
})`;

const results = {};
for (const id of ["globnotes-light", "globnotes-dark", "dracula", "catppuccin-latte"]) {
  await page.evaluate(`localStorage.setItem("globnotes-theme", "${id}")`);
  await page.reload();
  await page.waitForTimeout(600);
  results[id] = await page.evaluate(SAMPLE);
  console.log(`--- ${id} ---`);
  console.log(JSON.stringify(results[id]));
}

const bgs = new Set(Object.values(results).map((r) => r.bodyBg));
const navs = new Set(Object.values(results).map((r) => r.navBg));
console.log("distinct body bgs:", bgs.size, "distinct nav bgs:", navs.size);
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
page.close();
process.exit(bgs.size > 1 ? 0 : 1);
