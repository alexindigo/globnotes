// Editor modes over CDP: Source (CodeMirror 6) and WYSIWYG (Milkdown)
// both render the content; content survives mode switches.
import { connect } from "./cdp.mjs";
// DOM click (not CDP coordinates): immune to post-render layout shifts.
async function domClick(page, text) {
  const ok = await page.evaluate(`(() => {
    const els = [...document.querySelectorAll("button, a")].filter(
      (e) => e.offsetParent !== null,
    );
    const el = els.find((e) => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error("domClick target not found: " + text);
}

const BASE = process.env.BASE_URL || "http://localhost:8080";
const PORT = Number(process.env.CDP_PORT || 9333);

const page = await connect({ port: PORT });
await page.goto(`${BASE}/rendering/code-blocks`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

// Close the drawer if it covers the page
const drawerOpen = await page.evaluate(`(() => {
  const a = document.querySelector("aside");
  return a && getComputedStyle(a).display !== "none";
})()`);
if (drawerOpen) {
  await page.evaluate(`document.querySelector('aside button[title="Close sidebar"]')?.click()`);
  await page.poll(`getComputedStyle(document.querySelector("aside")).display === "none"`);
}

await domClick(page, "Edit");
await page.poll(`!!document.querySelector(".cm-editor")`);

const mdState = await page.evaluate(`({
  cmPresent: !!document.querySelector(".cm-editor"),
  hasCodeText: document.body.innerText.includes("def greet"),
  sourceActive: [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Source"),
})`);
console.log("markdown mode:", JSON.stringify(mdState));

// Switch to WYSIWYG via the Source/WYSIWYG toggle.
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "WYSIWYG");
  el?.click();
  return true;
})()`);
await page.poll(`!!document.querySelector(".ProseMirror")`, { timeout: 15000 });

const wyState = await page.evaluate(`({
  wysiwygContent: !!document.querySelector(".ProseMirror"),
  codeBlocksInEditor: document.querySelectorAll(".ProseMirror pre").length,
  hasCodeText: document.body.innerText.includes("def greet"),
})`);
console.log("wysiwyg mode:", JSON.stringify(wyState));

// Back to Source
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Source");
  el?.click();
  return true;
})()`);
await page.poll(`!!document.querySelector(".cm-editor")`, { timeout: 15000 });
const backState = await page.evaluate(`({
  hasCodeText: document.body.innerText.includes("def greet"),
})`);
console.log("back to markdown:", JSON.stringify(backState));
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
const ok = mdState.cmPresent &&
  mdState.hasCodeText &&
  wyState.wysiwygContent &&
  wyState.codeBlocksInEditor > 0 &&
  backState.hasCodeText;
page.close();
process.exit(ok ? 0 : 1);
