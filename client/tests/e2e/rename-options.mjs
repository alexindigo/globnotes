// Rename strategies over CDP: move / relink / none, fixture-managed.
// Usage: node client/tests/e2e/rename-options.mjs <move|relink|none>
import { connect } from "./cdp.mjs";
import {
  resetMovingNoteFixture,
  restoreMovingNoteFixture,
} from "./fixtures.mjs";

const OPTION = process.argv[2] || "move";
const TARGET =
  OPTION === "move" ? "archive-move" : OPTION === "relink" ? "archive-relink" : "archive-none";
const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);

resetMovingNoteFixture(TARGET);

const page = await connect({ port: PORT });
await page.addInitScript(`localStorage.setItem("sidebarVisible", "false")`);

await page.goto(`${BASE}/rename-me/moving-note`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
const beforeOk = await page.evaluate(`(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return el ? el.complete && el.naturalWidth > 0 : false;
})()`);

await page.clickText("Edit");
await page.waitForTimeout(1000);

// Folder field = the input currently holding 'rename-me'
const filled = await page.evaluate(`(() => {
  const inputs = [...document.querySelectorAll("input")].filter((i) => i.offsetParent !== null);
  const el = inputs.find((i) => i.value === "rename-me");
  if (!el) return false;
  el.value = ${JSON.stringify(TARGET)};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
if (!filled) throw new Error("folder input not found");

await page.clickText("Save");
await page.waitForTimeout(1500);

const dialogVisible = await page.evaluate(
  `document.body.innerText.includes("Move note with attachments")`,
);

const label = {
  move: "Move files with the note",
  relink: "Keep files, fix the links",
  none: "Don't touch anything",
}[OPTION];
await page.clickText(label);
await page.waitForTimeout(1500);

// Reload: the viewer doesn't re-render on prop change
await page.reload();
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
await page.waitForTimeout(800);

const after = await page.evaluate(`(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return {
    url: location.pathname,
    imgLoaded: el ? el.complete && el.naturalWidth > 0 : null,
    imgSrcAttr: el?.getAttribute("src"),
    imgResolved: el?.src,
  };
})()`);

console.log(
  JSON.stringify({
    option: OPTION, target: TARGET, beforeOk, dialogVisible,
    afterUrl: after.url, imgSrcAttr: after.imgSrcAttr,
    imgResolved: after.imgResolved, imgLoaded: after.imgLoaded,
    pageErrors: page.pageErrors.length ? page.pageErrors : "none",
  }),
);

restoreMovingNoteFixture(TARGET);
page.close();
