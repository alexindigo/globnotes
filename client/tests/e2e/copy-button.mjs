// Copy button on code blocks, over CDP.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);

const page = await connect({ port: PORT });
await page.addInitScript(`localStorage.setItem("sidebarVisible", "false")`);
await page.grantClipboard(BASE);

await page.goto(`${BASE}/rendering/code-blocks`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

const buttons = await page.evaluate(
  `document.querySelectorAll(".code-copy-btn").length`,
);
console.log("copy buttons found:", buttons);

if (buttons > 0) {
  await page.click(".code-copy-btn");
  await page.waitForTimeout(300);
  const clip = await page.readClipboard();
  const ok = clip.includes("def greet");
  console.log("clipboard contains the block:", ok);
  console.log(ok ? "COPY BUTTON OK" : "COPY BUTTON BROKEN");
} else {
  console.log("COPY BUTTON MISSING");
}
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
page.close();
process.exit(buttons > 0 ? 0 : 1);
