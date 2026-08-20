// Rename strategies over CDP: move / relink / none, fixture-managed.
// Usage: node client/tests/e2e/rename-options.mjs <move|relink|none>
import { readFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.mjs";

const OPTION = process.argv[2] || "move";
const TARGET =
  OPTION === "move" ? "archive-move" : OPTION === "relink" ? "archive-relink" : "archive-none";
const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);
const VAULT = join(homedir(), "globnotes-test-vault");

const FIXTURE_NOTE = `# Moving note

This note references an image in its own folder:

![pic](assets/pic.png)
`;

function resetFixture() {
  rmSync(join(VAULT, TARGET), { recursive: true, force: true });
  rmSync(join(VAULT, "rename-me"), { recursive: true, force: true });
  mkdirSync(join(VAULT, "rename-me", "assets"), { recursive: true });
  writeFileSync(join(VAULT, "rename-me", "moving-note.md"), FIXTURE_NOTE);
  cpSync(
    join(VAULT, "links", "assets", "glob-icon.png"),
    join(VAULT, "rename-me", "assets", "pic.png"),
  );
}

function restoreFixture() {
  // The note always moves to TARGET; copy it back. The asset only moved
  // under "move".
  mkdirSync(join(VAULT, "rename-me", "assets"), { recursive: true });
  try {
    cpSync(join(VAULT, TARGET, "moving-note.md"), join(VAULT, "rename-me", "moving-note.md"));
  } catch {}
  try {
    cpSync(join(VAULT, TARGET, "assets", "pic.png"), join(VAULT, "rename-me", "assets", "pic.png"));
  } catch {}
  rmSync(join(VAULT, TARGET), { recursive: true, force: true });
  // Undo wikilink rewrites the rename caused in other fixture notes.
  let files = [];
  try {
    files = execSync(`find ${VAULT} -name '*.md' -type f`, { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {}
  for (const f of files) {
    const c = readFileSync(f, "utf8");
    const fixed = c.replaceAll(
      /\[\[archive[^/\]]*\/moving-note/g,
      "[[rename-me/moving-note",
    );
    if (fixed !== c) writeFileSync(f, fixed);
  }
}

resetFixture();

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

restoreFixture();
page.close();
