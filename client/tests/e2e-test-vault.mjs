// Verify each test-vault asset note renders its signature element.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const PAGES = [
  ["readme", ".toastui-editor-contents a", "wikilinks render"],
  ["rendering/code-blocks", ".token", "prism tokens"],
  ["rendering/math", ".katex", "katex spans"],
  ["rendering/callouts", ".toastui-editor-contents blockquote", "callout blockquotes"],
  ["rendering/highlights", "mark", "highlight marks"],
  ["rendering/mermaid", ".mermaid svg", "mermaid svg"],
  ["rendering/frontmatter", ".toastui-editor-contents", "frontmatter note renders"],
  ["links/wiki-links", "a", "links render"],
  ["links/embeds", "img", "embedded image"],
  ["folders/dad/recipes/soup", "h1", "nested note"],
  ["rename-me/moving-note", "img", "attachment image"],
];

const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;

for (const [path, selector, label] of PAGES) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/${path}`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const found = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    selector,
  );
  const ok = found > 0 && errors.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${path}: ${label} (${found})${errors.length ? " errors=" + errors.join(";") : ""}`,
  );
}
console.log(failures === 0 ? "ALL PAGES OK" : `${failures} FAILURES`);
await browser.close();
