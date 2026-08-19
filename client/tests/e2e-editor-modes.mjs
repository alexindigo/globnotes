// E2E: editor modes render code properly.
// Markdown mode (CodeMirror) and WYSIWYG mode should both show code with
// highlighting; switching between them must not lose content.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/rendering/code-blocks`, { waitUntil: "load" });
await page.waitForTimeout(1500);

// Close the sidebar drawer if open (it intercepts clicks via its backdrop)
if (await page.evaluate(() => !!document.querySelector("aside"))) {
  await page.click("aside button:has(svg)");
  await page.waitForTimeout(400);
}

// Enter edit mode
await page.click("text=Edit");
await page.waitForTimeout(1200);

const mdState = await page.evaluate(() => {
  const cm = document.querySelector(".CodeMirror, .toastui-editor-md-container");
  const cmLines = document.querySelectorAll(".CodeMirror-line, .toastui-editor-md-code-block-line").length;
  const hasCode = document.body.innerText.includes("def greet");
  return {
    mode: document.querySelector(".toastui-editor-md-container") ? "markdown-ish" : "other",
    cmPresent: !!cm,
    codeLines: cmLines,
    hasCodeText: hasCode,
  };
});
console.log("markdown mode:", JSON.stringify(mdState));

// Switch to WYSIWYG
await page.click("text=WYSIWYG").catch(async () => {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("button, .toastui-editor-mode-switch")].find((b) =>
      b.textContent.toLowerCase().includes("wysiwyg"),
    );
    el?.click();
  });
});
await page.waitForTimeout(1000);

const wyState = await page.evaluate(() => ({
  wysiwygContent: !!document.querySelector(".toastui-editor-ww-container, .ProseMirror"),
  tokensInEditor: document.querySelectorAll(".toastui-editor-ww-container .token, .ProseMirror .token").length,
  codeBlocksInEditor: document.querySelectorAll(".toastui-editor-ww-container pre, .ProseMirror pre").length,
  hasCodeText: document.body.innerText.includes("def greet"),
}));
console.log("wysiwyg mode:", JSON.stringify(wyState));

// Switch back to markdown and confirm content preserved
await page.click("text=Markdown").catch(() => null);
await page.waitForTimeout(800);
const backState = await page.evaluate(() => ({
  hasCodeText: document.body.innerText.includes("def greet"),
  tokens: document.querySelectorAll(".token").length,
}));
console.log("back to markdown:", JSON.stringify(backState));
console.log("pageerrors:", errors.length ? errors : "none");
await browser.close();
