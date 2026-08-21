// Client-driven link updates on rename: renaming a note must update
// wikilinks in referencing notes (readme + ideas link to the fixture note),
// driven by the client (search -> rewrite -> resave), with the server a
// pure mechanism.
import { connect } from "./cdp.mjs";
import {
  resetMovingNoteFixture,
  restoreMovingNoteFixture,
} from "./fixtures.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);

// Clean fixture state, target included.
resetMovingNoteFixture("archive-client");

const page = await connect({ port: PORT });
await page.addInitScript(`localStorage.setItem("sidebarVisible", "false")`);
await page.goto(`${BASE}/rename-me/moving-note`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

// readme + ideas link to the fixture note
const beforeReadme = await page.evaluate(`(async () => {
  const r = await fetch("/_/api/notes/readme");
  return (await r.json()).content;
})()`);
console.log("readme links before:", beforeReadme.includes("[[rename-me/moving-note"));

// Rename via the UI: edit, change folder to archive-client, save, move
await page.clickText("Edit");
await page.waitForTimeout(1000);
await page.evaluate(`(() => {
  const inputs = [...document.querySelectorAll("input")].filter((i) => i.offsetParent !== null);
  const el = inputs.find((i) => i.value === "rename-me");
  if (!el) throw new Error("folder input not found");
  el.value = "archive-client";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await page.clickText("Save");
await page.waitForTimeout(1200);
await page.clickText("Move files with the note");
await page.poll(`location.pathname === "/archive-client/moving-note"`, { timeout: 15000 });

// Give the client-driven link update a beat to finish the resaves
await page.waitForTimeout(2500);

const afterReadme = await page.evaluate(`(async () => {
  const r = await fetch("/_/api/notes/readme");
  return (await r.json()).content;
})()`);
const afterIdeas = await page.evaluate(`(async () => {
  const r = await fetch("/_/api/notes/folders/mom/ideas");
  return (await r.json()).content;
})()`);
console.log("readme links after:", afterReadme.includes("[[archive-client/moving-note"));
console.log("ideas links after:", afterIdeas.includes("[[archive-client/moving-note"));
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
const ok =
  afterReadme.includes("[[archive-client/moving-note") &&
  afterIdeas.includes("[[archive-client/moving-note");
console.log(ok ? "CLIENT-DRIVEN LINK UPDATE OK" : "CLIENT-DRIVEN LINK UPDATE BROKEN");
page.close();

// Restore the fixture (note, asset, and any links the rename rewrote).
restoreMovingNoteFixture("archive-client");
process.exit(ok ? 0 : 1);
