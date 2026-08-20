// Test-vault page sweep over CDP: each fixture note renders its signature
// element with no page exceptions.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);
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

const page = await connect({ port: PORT });
let failures = 0;

for (const [path, selector, label] of PAGES) {
  const before = page.pageErrors.length;
  await page.goto(`${BASE}/${path}`);
  await page.poll(
    `document.querySelector(".toastui-editor-contents") !== null`,
  );
  const found = await page.evaluate(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
  const errs = page.pageErrors.slice(before);
  const ok = found > 0 && errs.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${path}: ${label} (${found})${errs.length ? " errors=" + errs.join(";") : ""}`,
  );
}
console.log(failures === 0 ? "ALL PAGES OK" : `${failures} FAILURES`);
page.close();
process.exit(failures ? 1 : 0);
