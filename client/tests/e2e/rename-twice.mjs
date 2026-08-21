// Two-step rename: move then relink. Verifies server content and what
// the UI shows after each step.
import { connect } from "./cdp.mjs";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);
const VAULT = join(homedir(), "globnotes-test-vault");

// Reset fixture to rename-me/moving-note with assets/pic.png, and clear
// any leftover targets from previous runs (a crashed run leaves them and
// the next rename 409s).
rmSync(join(VAULT, "rename-me"), { recursive: true, force: true });
rmSync(join(VAULT, "archive"), { recursive: true, force: true });
rmSync(join(VAULT, "archive1"), { recursive: true, force: true });
mkdirSync(join(VAULT, "rename-me", "assets"), { recursive: true });
writeFileSync(
  join(VAULT, "rename-me", "moving-note.md"),
  "# Moving note\n\n![pic](assets/pic.png)\n",
);
cpSync(
  join(VAULT, "links", "assets", "glob-icon.png"),
  join(VAULT, "rename-me", "assets", "pic.png"),
);

const page = await connect({ port: PORT });
await page.addInitScript(`localStorage.setItem("sidebarVisible", "false")`);

async function renameTo(target, optionLabel) {
  await page.goto(`${BASE}/${currentTitle()}`);
  await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
  await page.clickText("Edit");
  await page.waitForTimeout(1000);
  await page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll("input")].filter((i) => i.offsetParent !== null);
    const folder = inputs.find((i) => i.value === ${JSON.stringify(currentFolder())});
    if (!folder) throw new Error("folder input not found holding " + ${JSON.stringify(currentFolder())});
    folder.value = ${JSON.stringify(target)};
    folder.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await page.clickText("Save");
  await page.waitForTimeout(1500);
  await page.clickText(optionLabel);
  // Save completion signal: the router moves to the new title's URL.
  await page.poll(
    `location.pathname === "/${target}/moving-note"`,
    { timeout: 15000 },
  );
  await page.waitForTimeout(800);
}

let _title = "rename-me/moving-note";
function currentTitle() { return _title; }
function currentFolder() { return _title.split("/").slice(0, -1).join("/"); }

async function serverContent() {
  return page.evaluate(`(async () => {
    const r = await fetch("/_/api/notes/${_title}");
    return (await r.json()).content;
  })()`);
}

async function uiShownSrc() {
  return page.evaluate(`(() => {
    const el = document.querySelector(".toastui-editor-contents img");
    return el ? el.getAttribute("src") : null;
  })()`);
}

// Step 1: rename-me -> archive with move
await renameTo("archive", "Move files with the note");
_title = "archive/moving-note";
console.log("after move: server content:", JSON.stringify(await serverContent()));
console.log("after move: UI shows src:", await uiShownSrc());

// Step 2: archive -> archive1 with relink
await renameTo("archive1", "Keep files, fix the links");
_title = "archive1/moving-note";
console.log("after relink: server content:", JSON.stringify(await serverContent()));
console.log("after relink: UI shows src:", await uiShownSrc());
console.log("after relink: page reload then UI src:", await (async () => {
  await page.reload();
  await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
  return uiShownSrc();
})());

console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
// Success: the relinked content is visible in the UI without a reload.
const relinked = await uiShownSrc();
console.log(relinked === "../archive/assets/pic.png" ? "TWO-STEP RENAME OK" : "TWO-STEP RENAME BROKEN");
page.close();
