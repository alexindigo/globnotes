// Editor modes over CDP: markdown (CodeMirror) and WYSIWYG both render
// themed code; content survives mode switches.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
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

await page.clickText("Edit");
await page.poll(`!!document.querySelector(".CodeMirror, .toastui-editor-md-container")`);

const mdState = await page.evaluate(`({
  cmPresent: !!document.querySelector(".CodeMirror, .toastui-editor-md-container"),
  hasCodeText: document.body.innerText.includes("def greet"),
})`);
console.log("markdown mode:", JSON.stringify(mdState));

// Switch to WYSIWYG
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll("button, .toastui-editor-mode-switch div, .toastui-editor-mode-switch label")].find((b) => b.textContent.toLowerCase().includes("wysiwyg"));
  el?.click();
  return true;
})()`);
await page.waitForTimeout(1200);

const wyState = await page.evaluate(`({
  wysiwygContent: !!document.querySelector(".toastui-editor-ww-container, .ProseMirror"),
  tokensInEditor: document.querySelectorAll(".toastui-editor-ww-container .token, .ProseMirror .token").length,
  codeBlocksInEditor: document.querySelectorAll(".toastui-editor-ww-container pre, .ProseMirror pre").length,
  hasCodeText: document.body.innerText.includes("def greet"),
})`);
console.log("wysiwyg mode:", JSON.stringify(wyState));

// Back to markdown
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll("button, .toastui-editor-mode-switch div, .toastui-editor-mode-switch label")].find((b) => b.textContent.trim().toLowerCase() === "markdown");
  el?.click();
  return true;
})()`);
await page.waitForTimeout(800);
const backState = await page.evaluate(`({
  hasCodeText: document.body.innerText.includes("def greet"),
  tokens: document.querySelectorAll(".token").length,
})`);
console.log("back to markdown:", JSON.stringify(backState));
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
const ok = mdState.cmPresent && wyState.wysiwygContent && wyState.tokensInEditor > 0 && backState.hasCodeText;
page.close();
process.exit(ok ? 0 : 1);
