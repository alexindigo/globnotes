// Realistic-profile rename test: browser with accumulated state
// (theme chosen, folders expanded, drawer open) — the state a returning
// user's browser actually has.
import { chromium } from "playwright";

const BASE = "http://localhost:8000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Accumulated state as a returning user would have it
await page.addInitScript(() => {
  localStorage.setItem("globnotes-theme", "tokyo-night");
  localStorage.setItem(
    "expandedFolders",
    JSON.stringify(["rendering", "links", "rename-me"]),
  );
  localStorage.setItem("sidebarVisible", "true");
});

await page.goto(`${BASE}/rename-me/moving-note`, { waitUntil: "load" });
await page.waitForTimeout(2000);

const state = await page.evaluate(() => ({
  theme: localStorage.getItem("globnotes-theme"),
  brandVar: document.documentElement.style.getPropertyValue("--theme-brand").trim(),
  bodyDark: document.body.classList.contains("dark"),
  noteTitle: document.querySelector(".text-3xl")?.textContent,
  imgOk: (() => {
    const el = document.querySelector(".toastui-editor-contents img");
    return el ? el.complete && el.naturalWidth > 0 : false;
  })(),
  drawerOpen: !!document.querySelector("aside"),
  drawerShowsRenameMe: document.body.innerText.includes("moving-note"),
}));
console.log("loaded state:", JSON.stringify(state, null, 1));

// Close the drawer via its own close control (user-realistic)
await page.click("aside button:has(svg)");
await page.waitForTimeout(400);

// Edit -> change folder -> Save
await page.click("text=Edit");
await page.waitForTimeout(1000);
const inputs = page.locator("input:visible");
const n = await inputs.count();
for (let i = 0; i < n; i++) {
  const v = await inputs.nth(i).inputValue().catch(() => "");
  if (v === "rename-me") {
    await inputs.nth(i).fill("archive");
  }
}
await page.click("text=Save");
await page.waitForTimeout(1500);

const dialog = await page.evaluate(() => ({
  visible: document.body.innerText.includes("Move note with attachments"),
  move: document.body.innerText.includes("Move files with the note"),
}));
console.log("dialog:", JSON.stringify(dialog));

if (dialog.visible) {
  await page.click("text=Move files with the note");
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    url: location.pathname,
    imgOk: (() => {
      const el = document.querySelector(".toastui-editor-contents img");
      return el ? el.complete && el.naturalWidth > 0 : false;
    })(),
    bodyDark: document.body.classList.contains("dark"),
  }));
  console.log("after move:", JSON.stringify(after));
}
console.log("pageerrors:", errors.length ? errors : "none");
await browser.close();
