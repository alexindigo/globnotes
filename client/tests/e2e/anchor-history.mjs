// WS3 pin (issue #5 quirk 2): in-page anchor clicks must not hijack note
// history. Each check names the CORRECT behavior; on the pre-fix build the
// history/repro checks fail (that's the pin), the guard checks pass on both.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";

const CDP_PORT = Number(process.env.CDP_PORT || 9460);
const vault = await Deno.makeTempDir({ prefix: "anchor-vault-" });

const FILLER = Array.from(
  { length: 60 },
  (_, i) => `Filler line ${i} to make the page tall enough to scroll.`,
).join("\n\n");
await Deno.writeTextFile(
  `${vault}/anchors.md`,
  [
    "[Coding Rules](#section-one)",
    "",
    "[[other-note]]",
    "",
    FILLER,
    "",
    '<a id="section-one"></a>',
    "# Coding Rules",
    "",
    FILLER,
    "",
    '<a id="section-two"></a>',
    "## Dark Theme",
    "",
  ].join("\n"),
);
await Deno.writeTextFile(`${vault}/other-note.md`, "# Other\n");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`ok: ${name}`);
  } else {
    failures++;
    console.log(`PIN-FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const server = await bootServer({
  GLOBNOTES_PATH: vault,
  GLOBNOTES_AUTH_TYPE: "none",
  GLOBNOTES_PATH_PREFIX: "",
});
const browser = await launchBrowser({ port: CDP_PORT });
try {
  const page = await connect({ port: CDP_PORT });
  // §6 asks for both themes: THEME=dark runs the same checks dark-side.
  if (process.env.THEME) {
    await page.addInitScript(
      `localStorage.setItem("globnotes-theme", ${JSON.stringify(process.env.THEME)})`,
    );
  }
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  // -- A: view-mode anchor click must not push history ----------------------
  await page.goto(`${server.baseUrl}/anchors`);
  await page.poll(`document.querySelector('.rendered-markdown a[href="#section-one"]') !== null`);
  const h0 = await page.evaluate("history.length");
  await page.clickText("Coding Rules");
  await page.waitForTimeout(400);
  const h1 = await page.evaluate("history.length");
  check("anchor click pushes no history entry", h1 === h0, `len ${h0}→${h1}`);
  const scrolled = await page.evaluate(
    `(() => { const el = document.getElementById("section-one"); const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; })()`,
  );
  check("anchor click scrolls the target into view", scrolled);

  // -- B: the issue's exact repro — preview tab, anchor, BACK ---------------
  await page.goto(`${server.baseUrl}/anchors`);
  await page.poll(`document.querySelector('.rendered-markdown a[href="#section-one"]') !== null`);
  await page.clickText("Edit");
  await page.poll(`document.querySelector(".cm-host, .ProseMirror") !== null`);
  await page.clickText("Preview");
  await page.poll(
    `document.querySelector('.preview-buffer a[href="#section-one"]') !== null`,
  );
  await page.clickText("Coding Rules");
  await page.waitForTimeout(400);
  await page.evaluate("history.back()");
  await page.waitForTimeout(600);
  // The deliberate "back out of edit" gate means BACK exits preview to
  // view mode; the bug forced the source editor instead. Correct = a
  // rendered surface (view/preview), never a forced source editor.
  const backState = await page.evaluate(`JSON.stringify({
    rendered: !!document.querySelector(".rendered-markdown"),
    sourceEditor: !!document.querySelector(".cm-host, .ProseMirror"),
  })`);
  const bs = JSON.parse(backState);
  check(
    "BACK from a preview anchor never forces the source editor",
    bs.rendered && !bs.sourceEditor,
    backState,
  );

  // -- C: BACK returns to the originating page (not edit mode) ---------------
  await page.goto(`${server.baseUrl}/`);
  await page.poll(`document.querySelector(".content-column") !== null`);
  await page.goto(`${server.baseUrl}/anchors`);
  await page.poll(`document.querySelector('.rendered-markdown a[href="#section-one"]') !== null`);
  await page.clickText("Coding Rules");
  await page.waitForTimeout(400);
  await page.evaluate("history.back()");
  await page.waitForTimeout(600);
  const state = await page.evaluate(`JSON.stringify({
    path: location.pathname,
    sourceEditor: !!document.querySelector(".cm-host, .ProseMirror"),
  })`);
  const parsed = JSON.parse(state);
  check(
    "BACK from a view-mode anchor returns to the origin page",
    parsed.path === "/" && !parsed.sourceEditor,
    state,
  );

  // -- D: fresh boot at a deep link renders view + highlight ----------------
  await page.goto(`${server.baseUrl}/anchors#view:L5`);
  await page.poll(`document.querySelector('.rendered-markdown a[href="#section-one"]') !== null`);
  await page.waitForTimeout(400);
  const highlighted = await page.evaluate(
    `document.querySelector(".line-highlight") !== null`,
  );
  const noEditor = await page.evaluate(
    `document.querySelector(".cm-host, .ProseMirror") === null`,
  );
  check("#view:L5 deep-link still highlights", highlighted);
  check("#view:L5 boots into view mode (no editor)", noEditor);

  // -- D2: edit deep links still boot into their editor modes ----------------
  await page.goto(`${server.baseUrl}/anchors#edit`);
  await page.poll(`document.querySelector(".ProseMirror") !== null`);
  const editUrl = await page.evaluate("location.hash");
  check("#edit boots into the WYSIWYG editor", editUrl === "#edit");

  await page.goto(`${server.baseUrl}/anchors#source:L5`);
  await page.poll(`document.querySelector(".cm-host") !== null`);
  const sourceUrl = await page.evaluate("location.hash");
  check("#source:L5 boots into the source editor", sourceUrl === "#source:L5");

  // -- E: wikilinks still navigate -------------------------------------------
  await page.goto(`${server.baseUrl}/anchors`);
  await page.poll(`document.querySelector('.rendered-markdown a[href="#section-one"]') !== null`);
  await page.clickText("other-note");
  await page.poll(`location.pathname.includes("other-note")`);
  check("wikilink to another note still navigates", true);

  if (failures > 0) {
    console.log(`ANCHOR HISTORY: ${failures} pinned failure(s)`);
    process.exit(1);
  }
  console.log("ANCHOR HISTORY OK");
} finally {
  await stopBrowser(browser);
  await server.close();
  Deno.removeSync(vault, { recursive: true });
}
