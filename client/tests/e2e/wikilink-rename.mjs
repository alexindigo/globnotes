// Wikilinks update on rename, via the UI, over CDP.
import { connect } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const PORT = Number(process.env.CDP_PORT || 9333);

// Fixture via API
await fetch(`${BASE}/_/api/notes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "probe/link-source", content: "see [[probe/link-target]]" }),
});
await fetch(`${BASE}/_/api/notes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "probe/link-target", content: "# Target" }),
});

const page = await connect({ port: PORT });
await page.goto(`${BASE}/probe/link-target`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);

// Close drawer if covering
const drawerOpen = await page.evaluate(`(() => {
  const a = document.querySelector("aside");
  return a && getComputedStyle(a).display !== "none";
})()`);
if (drawerOpen) {
  await page.evaluate(`document.querySelector('aside button[title="Close sidebar"]')?.click()`);
  await page.poll(`getComputedStyle(document.querySelector("aside")).display === "none"`);
}

await page.clickText("Edit");
await page.poll(`!!document.querySelector("input")`);

// The basename field is the first visible input
await page.fill("input", "link-target-renamed");
await page.clickText("Save");
await page.poll(`location.pathname === "/probe/link-target-renamed"`);

await page.goto(`${BASE}/probe/link-source`);
await page.poll(`document.querySelector(".toastui-editor-contents") !== null`);
const link = await page.evaluate(`(() => {
  const a = [...document.querySelectorAll(".toastui-editor-contents a")].find((x) => x.textContent.includes("link"));
  return a ? { text: a.textContent, href: a.getAttribute("href") } : null;
})()`);
const content = await page.evaluate(`(async () => {
  const r = await fetch("/_/api/notes/probe/link-source");
  return (await r.json()).content;
})()`);
console.log("source link:", JSON.stringify(link));
console.log("source content:", JSON.stringify(content));
const ok = content.includes("[[probe/link-target-renamed]]");
console.log(ok ? "WIKILINK RENAME OK" : "WIKILINK RENAME BROKEN");
console.log("pageerrors:", page.pageErrors.length ? page.pageErrors : "none");
page.close();

// Cleanup fixture
await fetch(`${BASE}/_/api/notes/probe/link-source`, { method: "DELETE" });
await fetch(`${BASE}/_/api/notes/probe/link-target-renamed`, { method: "DELETE" });
process.exit(ok ? 0 : 1);
