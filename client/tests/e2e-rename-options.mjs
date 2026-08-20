// Test one rename strategy option end-to-end. Usage: node e2e-rename-options.mjs <move|relink|none>
import { chromium } from "playwright";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const OPTION = process.argv[2] || "move";
const TARGET =
  OPTION === "move"
    ? "archive-move"
    : OPTION === "relink"
      ? "archive-relink"
      : "archive-none";
const BASE = "http://localhost:8000";

// The harness shares the host with the vault — reset the fixture at the
// filesystem level so every run starts clean, and restore it after.
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
  const moved = join(VAULT, TARGET, "moving-note.md");
  const movedAsset = join(VAULT, TARGET, "assets", "pic.png");
  mkdirSync(join(VAULT, "rename-me", "assets"), { recursive: true });
  // The note always moves; copy it back. The asset only moved under
  // the "move" strategy — copy back if present, otherwise it never left.
  try {
    cpSync(moved, join(VAULT, "rename-me", "moving-note.md"));
  } catch {}
  try {
    cpSync(movedAsset, join(VAULT, "rename-me", "assets", "pic.png"));
  } catch {}
  rmSync(join(VAULT, TARGET), { recursive: true, force: true });
}

resetFixture();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.addInitScript(() => {
  localStorage.setItem("sidebarVisible", "false");
});

await page.goto(`${BASE}/rename-me/moving-note`, { waitUntil: "load" });
await page.waitForTimeout(1500);
const beforeOk = await page.evaluate(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return el ? el.complete && el.naturalWidth > 0 : false;
});

await page.click("text=Edit");
await page.waitForTimeout(1000);
const inputs = page.locator("input:visible");
for (let i = 0; i < (await inputs.count()); i++) {
  const v = await inputs.nth(i).inputValue().catch(() => "");
  if (v === "rename-me") {
    await inputs.nth(i).fill(TARGET);
  }
}
await page.click("text=Save");
await page.waitForTimeout(1500);

const label = {
  move: "Move files with the note",
  relink: "Keep files, fix the links",
  none: "Don't touch anything",
}[OPTION];

const dialogVisible = await page.evaluate((t) =>
  document.body.innerText.includes("Move note with attachments"),
);
await page.click(`text=${label}`);
await page.waitForTimeout(1800);

// The viewer doesn't re-render on prop change (ToastUI reads initialValue
// once at mount) — reload the note page to see the post-move render.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1500);

const after = await page.evaluate(() => {
  const el = document.querySelector(".toastui-editor-contents img");
  return {
    url: location.pathname,
    imgLoaded: el ? el.complete && el.naturalWidth > 0 : null,
    imgSrcAttr: el?.getAttribute("src"),
    imgResolved: el?.src,
    pageErrors: null,
  };
});
console.log(
  JSON.stringify({
    option: OPTION,
    target: TARGET,
    beforeOk,
    dialogVisible,
    afterUrl: after.url,
    imgSrcAttr: after.imgSrcAttr,
    imgResolved: after.imgResolved,
    imgLoaded: after.imgLoaded,
    pageErrors: errors.length ? errors : "none",
  }),
);

restoreFixture();
await browser.close();
