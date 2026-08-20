// Tour chain over CDP: walk the Next links through all 12 fixture notes.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);
const CHAIN = [
  "readme",
  "rendering/code-blocks",
  "rendering/math",
  "rendering/callouts",
  "rendering/highlights",
  "rendering/mermaid",
  "rendering/frontmatter",
  "links/wiki-links",
  "links/embeds",
  "folders/dad/recipes/soup",
  "folders/mom/ideas",
  "rename-me/moving-note",
];

const page = await connect({ port: PORT });

await page.goto(`${BASE}/readme`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

// Close the sidebar drawer if it's covering the page (v-show keeps the
// aside in the DOM — check computed display, not presence).
const drawerOpen = await page.evaluate(`(() => {
  const a = document.querySelector("aside");
  return a && getComputedStyle(a).display !== "none";
})()`);
if (drawerOpen) {
  await page.evaluate(`document.querySelector('aside button[title="Close sidebar"]')?.click()`);
  await page.poll(`getComputedStyle(document.querySelector("aside")).display === "none"`);
}

let current = "readme";
let hops = 0;
let broken = null;

while (hops < CHAIN.length) {
  const expected = CHAIN[hops + 1];
  if (!expected) break;
  const found = await page.evaluate(
    `!!document.querySelector('.toastui-editor-contents a[href="/${expected}"]')`,
  );
  if (!found) {
    broken = current;
    break;
  }
  await page.evaluate(
    `document.querySelector('.toastui-editor-contents a[href="/${expected}"]').click()`,
  );
  await page.poll(`location.pathname === "/${expected}"`);
  // SPA navigation swaps the viewer async — wait for the new content.
  await page.poll(
    `document.querySelector(".toastui-editor-contents")?.innerHTML.length > 0`,
  );
  current = expected;
  hops++;
}

console.log(
  broken
    ? `CHAIN BROKEN at ${current} (hop ${hops})`
    : `CHAIN COMPLETE: ${hops} hops, ended at ${current}`,
);
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
page.close();
process.exit(broken ? 1 : 0);
