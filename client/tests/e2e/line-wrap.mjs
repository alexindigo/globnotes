// WS5 (issue #5 quirk 4): view/preview wrap long lines. Geometry proof:
// a 300-char unbroken token wraps (no page-level horizontal overflow);
// a long code line scrolls inside its block (never the page column);
// the line-numbers gutter stays aligned with its code lines.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";

const CDP_PORT = Number(process.env.CDP_PORT || 9462);
const vault = await Deno.makeTempDir({ prefix: "wrap-vault-" });
const longToken = "x".repeat(300);
const longCode = "const s = \"" + "y".repeat(180) + "\"; // long line";
await Deno.writeTextFile(
  `${vault}/wrap.md`,
  [
    "# Wrap test",
    "",
    `A paragraph with a long unbroken token: ${longToken} and then some.`,
    "",
    "```js",
    "const a = 1;",
    longCode,
    "const b = 2;",
    "```",
    "",
  ].join("\n"),
);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok: ${name}`);
  else {
    failures++;
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const server = await bootServer({
  GLOBNOTES_PATH: vault, GLOBNOTES_AUTH_TYPE: "none", GLOBNOTES_PATH_PREFIX: "",
});
const browser = await launchBrowser({ port: CDP_PORT });
try {
  const page = await connect({ port: CDP_PORT });
  await page.addInitScript(
    `localStorage.setItem("viewLineNumbers", "true")`,
  );
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1100, height: 850, deviceScaleFactor: 1, mobile: false,
  });

  await page.goto(`${server.baseUrl}/wrap`);
  await page.poll(`document.querySelector(".rendered-markdown") !== null`);
  await page.waitForTimeout(600);

  // 1. The long token wraps: no page-level horizontal overflow.
  const noPageOverflow = await page.evaluate(
    `document.documentElement.scrollWidth <= window.innerWidth`,
  );
  check("300-char token wraps (no page-level horizontal overflow)", noPageOverflow);

  // 2. The long code line scrolls inside its block, never the column.
  const pre = await page.evaluate(`(() => {
    const pre = [...document.querySelectorAll(".rendered-markdown pre")][0];
    return {
      blockScrolls: pre.scrollWidth > pre.clientWidth,
      clientWidth: pre.clientWidth,
    };
  })()`);
  const columnNoOverflow = await page.evaluate(
    `document.documentElement.scrollWidth <= window.innerWidth`,
  );
  check(
    "long code line scrolls inside the block",
    pre.blockScrolls,
    JSON.stringify(pre),
  );
  check("page column still doesn't overflow with the long code line", columnNoOverflow);

  // 3. Line-numbers gutter stays aligned with its code lines.
  const aligned = await page.evaluate(`(() => {
    const pre = document.querySelector(".rendered-markdown pre");
    const rows = [...pre.querySelectorAll(".line-numbers-rows > span")];
    if (!rows.length) return { rows: 0 };
    const lineTops = [...pre.querySelectorAll("[data-line]")].map(
      (el) => Math.round(el.getBoundingClientRect().top),
    );
    const gutterTops = rows.map((el) => Math.round(el.getBoundingClientRect().top));
    const maxDrift = Math.max(
      ...gutterTops.map((t, i) => Math.abs(t - lineTops[i] ?? 0)),
    );
    return { rows: rows.length, maxDrift };
  })()`);
  check(
    "line-numbers gutter aligned with code lines",
    aligned.rows > 0 && aligned.maxDrift <= 2,
    JSON.stringify(aligned),
  );

  await page.screenshot("/tmp/wrap-view.png");

  // Preview tab shares the class — same rules must hold there.
  await page.clickText("Edit");
  await page.poll(`document.querySelector(".cm-host") !== null`);
  await page.clickText("Preview");
  await page.poll(`document.querySelector(".preview-buffer pre") !== null`);
  await page.waitForTimeout(400);
  const previewNoOverflow = await page.evaluate(
    `document.documentElement.scrollWidth <= window.innerWidth`,
  );
  check("preview tab wraps too (no page-level overflow)", previewNoOverflow);

  if (failures > 0) {
    console.log(`WRAP: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("WRAP OK");
} finally {
  await stopBrowser(browser);
  await server.close();
  Deno.removeSync(vault, { recursive: true });
}
