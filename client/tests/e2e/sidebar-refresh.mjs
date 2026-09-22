// Sidebar live-refresh: create a note via the real UI path and assert the
// open sidebar lists it WITHOUT a page reload (regression: levels cache
// was never invalidated on NOTE_CREATE/RENAME/DELETE).
import { connect } from "./cdp.mjs";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VAULT = process.env.VAULT_PATH ||
  join(homedir(), "globnotes-test-vault");

const BASE = process.env.BASE_URL || "http://localhost:8004";
const PORT = Number(process.env.CDP_PORT || 9430);
const NOTE = "SidebarProbe";

const page = await connect({ port: PORT });
await page.addInitScript(`
  localStorage.setItem("sidebarVisible", "true");
  localStorage.setItem("sidebarPinned", "true");
`);

await page.goto(`${BASE}/_/login`);
// Auth is optional (the fixture vault runs with auth none) — log in only
// when a token endpoint answers.
await page.evaluate(`(async () => {
  const r = await fetch("/_/api/token", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "password1234" }) });
  if (!r.ok) return "skipped";
  const d = await r.json();
  sessionStorage.setItem("token", d.access_token);
  document.cookie = "token=" + d.access_token + "; Path=/; SameSite=Strict";
})()`);

await page.goto(`${BASE}/`);
await page.poll(`document.querySelector("aside") !== null`);
await page.poll(`getComputedStyle(document.querySelector("aside")).display !== "none"`);

const before = await page.evaluate(
  `document.querySelector("aside").textContent.includes(${JSON.stringify(NOTE)})`,
);
console.log("sidebar has note before create:", before, "(expect false)");

// Real UI path: New note → title → Save (SPA navigation, no page reload).
await page.click('button[title="New note"]');
await page.poll(`location.pathname.includes("/_/new")`);
await page.fill("input[placeholder=Title]", NOTE);
await page.clickText("Save");
await page.poll(`location.pathname.includes(${JSON.stringify(NOTE)})`);
console.log("created + routed to:", await page.evaluate("location.pathname"));

// The assertion that failed before the fix: sidebar updates live.
await page.poll(
  `document.querySelector("aside").textContent.includes(${JSON.stringify(NOTE)})`,
  { timeout: 6000 },
);
console.log("sidebar shows the new note WITHOUT reload: true");

await page.screenshot("/tmp/sidebar-refresh-fixed.png");

// Leave no trace: the probe note only existed to prove the live refresh.
rmSync(join(VAULT, `${NOTE}.md`), { force: true });

console.log("SIDEBAR REFRESH OK");
process.exit(0);
