// VM-only acceptance. Uses an already running native Chromium on CDP_PORT (9333).
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect } from "./cdp.mjs";
import { tabSave, tabToggleLeft, tabToggleRight } from "../../icons.js";
import { join } from "node:path";

const port = Number(Deno.env.get("CDP_PORT") || 9333);
const artifacts = await Deno.makeTempDir({ prefix: "button-icons-artifacts-" });
const vault = await Deno.makeTempDir({ prefix: "button-icons-vault-" });
const title = "button-icons";
const fixture = "# Button Icons\n\nDisposable button icon fixture.\n";
const editSelector = 'button[data-button-icons="Edit"]';
const saveSelector = 'button[data-button-icons="Save"]';
const saveIcon = `${saveSelector} svg`;
const events = [];
const measurements = [];
const stages = [];
let server, page, targetId, pendingMarker, failure;
let phase = "setup";
let completed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function bounded(label, operation, timeout = 15000) {
  const started = Date.now();
  let timer;
  console.log(JSON.stringify({ phase, stage: label, status: "start" }));
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${phase}: timed out at ${label}`)),
          timeout,
        );
      }),
    ]);
    stages.push({ phase, label, status: "done", ms: Date.now() - started });
    return result;
  } catch (error) {
    stages.push({
      phase,
      label,
      status: "failed",
      ms: Date.now() - started,
      error: error.message,
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toolbar() {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right };
  };
  const icon = (svg) => {
    const css = getComputedStyle(svg);
    const b = svg.getBBox();
    const m = svg.getScreenCTM();
    return {
      rect: rect(svg),
      stroke: css.stroke,
      font: css.fontSize,
      shrink: css.flexShrink,
      widthAttribute: svg.getAttribute("width"),
      heightAttribute: svg.getAttribute("height"),
      viewBox: svg.getAttribute("viewBox"),
      bbox: { w: b.width, h: b.height },
      scale: { x: m.a, y: m.d },
      paths: [...svg.querySelectorAll("path")].map((p) => {
        const box = p.getBBox();
        return {
          d: p.getAttribute("d"),
          length: p.getTotalLength(),
          bbox: { w: box.width, h: box.height },
          rect: rect(p),
          stroke: getComputedStyle(p).stroke,
        };
      }),
    };
  };
  const button = (text) => {
    const el = document.querySelector(`button[data-button-icons="${text}"]`);
    const visible = el.getBoundingClientRect().width > 0;
    if (!visible) return { visible };
    const label = el.querySelector("span");
    return {
      visible,
      rect: rect(el),
      icons: [...el.querySelectorAll("svg")].map(icon),
      label: { rect: rect(label), color: getComputedStyle(label).color },
      badges: [...el.querySelectorAll(".absolute")].filter(
        (e) => e.getBoundingClientRect().width > 0,
      ).map(rect),
    };
  };
  const root = getComputedStyle(document.documentElement);
  const color = (name) =>
    `rgb(${root.getPropertyValue(name).trim().split(/\s+/).join(", ")})`;
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    dark: document.body.classList.contains("dark"),
    brand: color("--theme-brand"),
    muted: color("--theme-text-muted"),
    edit: button("Edit"),
    save: button("Save"),
  };
}

async function markControls() {
  await page.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.content-column button')];
    for (const text of ['Edit', 'Save', 'Source']) {
      const button = buttons.find(b => b.textContent.trim() === text);
      if (button) button.setAttribute('data-button-icons', text);
    }
  })()`);
}

async function observe(state, editMode, dirty = false) {
  const label = `${phase} ${state}`;
  const m = await page.evaluate(`(${toolbar.toString()})()`);
  measurements.push({ label, measured: m });
  console.log(JSON.stringify({ label, measured: m }));
  await page.screenshot(join(artifacts, `${phase}-${state}.png`));
  const square = (icon, name) => {
    assert(
      Math.abs(icon.rect.w - 20) < 0.05,
      `${label}: ${name} SVG width expected 20px, got ${icon.rect.w}px`,
    );
    assert(
      Math.abs(icon.rect.h - 20) < 0.05,
      `${label}: ${name} SVG height expected 20px, got ${icon.rect.h}px`,
    );
  };
  const paths = (icon, expected, name) => {
    assert(
      JSON.stringify(icon.paths.map((p) => p.d)) === JSON.stringify(expected),
      `${label}: ${name} paths preserved`,
    );
    assert(
      icon.bbox.w > 0 && icon.bbox.h > 0 && icon.paths.every(
        (p) => p.length > 0 && p.bbox.w + p.bbox.h > 0,
      ),
      `${label}: ${name} has positive path geometry`,
    );
    assert(
      /^rgb\(\d+,\s*\d+,\s*\d+\)$/.test(icon.stroke) &&
        icon.paths.every((p) => p.stroke === icon.stroke),
      `${label}: ${name} RGB stroke`,
    );
    assert(
      icon.widthAttribute !== "auto" && icon.heightAttribute !== "auto",
      `${label}: ${name} has no invalid auto dimension attribute`,
    );
  };
  assert(
    m.edit.visible && m.edit.icons.length === 1,
    `${label}: one switch icon, no pencil`,
  );
  const pill = m.edit.icons[0];
  paths(pill, editMode ? tabToggleRight : tabToggleLeft, "switch");
  assert(pill.viewBox === "1 5 22 14", `${label}: switch crop preserved`);
  assert(
    Math.abs(pill.rect.h - 16) < 0.05 &&
      Math.abs(pill.rect.w - pill.rect.h * 22 / 14) < 0.05,
    `${label}: switch aspect 22/14 at 16px height`,
  );
  assert(
    pill.rect.right <= m.edit.label.rect.x,
    `${label}: switch precedes Edit label without overlap`,
  );
  assert(
    Math.abs(m.edit.label.rect.x - pill.rect.right - 4) < 0.05,
    `${label}: main-branch switch-to-label spacing is 4px`,
  );
  assert(
    m.save.visible === editMode,
    `${label}: Save visibility follows edit mode`,
  );
  if (editMode) {
    assert(m.save.icons.length === 1, `${label}: one Save icon`);
    square(m.save.icons[0], "Save");
    paths(m.save.icons[0], tabSave, "Save");
    assert(
      m.save.icons[0].rect.right <= m.save.label.rect.x,
      `${label}: Save label does not overlap its icon`,
    );
    assert(m.save.badges.length === 0, `${label}: no floating dirty badge`);
    assert(m.save.label.color === m.muted, `${label}: Save text remains muted`);
    assert(
      m.save.icons[0].stroke === (dirty ? m.brand : m.muted),
      `${label}: Save icon is ${dirty ? "brand" : "muted"} coloured`,
    );
  }
  return m;
}

async function moveAway() {
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
  });
}

async function savePending() {
  const marker = pendingMarker;
  if (!marker) return;
  await page.click(saveSelector);
  await moveAway();
  const noteUrl = `${server.baseUrl}/_/api/notes/${encodeURIComponent(title)}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await fetch(noteUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    assert(response.ok, `saved-note consumer GET returned ${response.status}`);
    const note = await response.json();
    if (note.content.includes(marker)) {
      pendingMarker = null;
      console.log(`saved-note consumer GET includes ${marker}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`saved-note consumer GET never received ${marker}`);
}

function checkDiagnostics() {
  assert(
    page.pageErrors.length === 0,
    `unexpected pageerrors: ${JSON.stringify(page.pageErrors)}`,
  );
  for (const event of events) {
    const { text, url, level } = event;
    assert(
      !(/<svg>.*attribute (?:width|height)/i.test(text) ||
        /Invalid prop:.*["']iconPath["'].*(?:Array|type check)/i.test(text)),
      `icon diagnostic: ${text}`,
    );
    // Existing webmanifest/apple-touch asset failures are unrelated to SVG controls.
    const manifest =
      (url?.includes(".webmanifest") && text.startsWith("Manifest:")) ||
      (url?.endsWith("apple-touch-icon.png") && text.includes("404")) ||
      (text.startsWith(
        "Error while trying to use the following icon from the Manifest:",
      ) &&
        text.includes("apple-touch-icon.png"));
    assert(
      manifest || !["error", "warning", "warn"].includes(level),
      `unexpected browser ${level}: ${text}`,
    );
  }
}

try {
  await Deno.writeTextFile(join(vault, `${title}.md`), fixture);
  server = await bootServer({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_INDEX_PATH: join(vault, ".globnotes"),
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_PATH_PREFIX: "",
  });
  console.log(`button-icons artifacts: ${artifacts}`);
  console.log(
    `own fixture: ${vault}; app: ${server.baseUrl}; external CDP: ${port}`,
  );
  page = await bounded("connect owned native target/context", () => connect({ port }));
  targetId = page.targetId;
  for (
    const name of ["send", "evaluate", "poll", "goto", "click", "screenshot"]
  ) {
    const method = page[name].bind(page);
    page[name] = (...args) =>
      bounded(
        `${name} ${String(args[0]).slice(0, 140)}`,
        () => method(...args),
        Math.max(15000, (name === "poll" ? args[1]?.timeout ?? 0 : 0) + 2000),
      );
  }
  page.onEvent((event) => {
    if (event.method === "Runtime.consoleAPICalled") {
      events.push({
        phase,
        channel: event.method,
        level: event.params.type,
        text: event.params.args.map((a) => a.value ?? a.description ?? "").join(
          " ",
        ),
      });
    } else if (event.method === "Log.entryAdded") {
      const { text, url, level } = event.params.entry;
      events.push({ phase, channel: event.method, text, url, level });
    } else if (event.method === "Page.javascriptDialogOpening") {
      events.push({
        phase,
        channel: event.method,
        level: "error",
        text: `unexpected ${event.params.type} dialog: ${event.params.message}`,
      });
    }
  });
  await page.send("Log.enable");
  for (const [width, height] of [[1280, 900], [1366, 768]]) {
    for (const dpr of [1, 2]) {
      for (const theme of ["light", "dark"]) {
        phase = `${width}x${height}-dpr${dpr}-${theme}`;
        await page.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: dpr,
          mobile: false,
        });
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        await page.goto(`${server.baseUrl}/${title}`);
        await page.poll(
          "document.querySelector('.toast-viewer')?.innerText.includes('Disposable button icon fixture')",
          { timeout: 20000 },
        );
        await page.evaluate("document.fonts.ready");
        await page.poll(
          `document.body.classList.contains('dark') === ${theme === "dark"}`,
        );
        await markControls();
        const view = await observe("view", false);
        assert(
          view.viewport.width === width && view.viewport.height === height &&
            view.viewport.dpr === dpr,
          `${phase}: actual viewport/DPR match`,
        );
        await page.click(editSelector);
        await page.poll(
          "[...document.querySelectorAll('.content-column button')].some(b => b.textContent.trim() === 'Source' && b.getBoundingClientRect().width > 0)",
        );
        await markControls();
        await page.click('button[data-button-icons="Source"]');
        await page.poll(
          "!!document.querySelector('.cm-content[contenteditable=true]')",
        );
        await moveAway();
        await observe("clean", true);
        const marker = `button-icons-disposable-${phase}`;
        await page.click(".cm-content");
        await page.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "End",
          code: "End",
          windowsVirtualKeyCode: 35,
          modifiers: 2,
        });
        await page.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "End",
          code: "End",
          windowsVirtualKeyCode: 35,
          modifiers: 2,
        });
        pendingMarker = marker;
        await page.send("Input.insertText", { text: `\n\n${marker}\n` });
        await page.poll(
          `document.querySelector('.cm-content')?.innerText.includes(${
            JSON.stringify(marker)
          })`,
        );
        await page.poll(
          `document.querySelector(${
            JSON.stringify(saveIcon)
          })?.classList.contains('text-theme-brand')`,
        );
        await moveAway();
        await observe("dirty", true, true);
        await savePending();
        await page.poll(
          `!document.querySelector(${
            JSON.stringify(saveIcon)
          })?.classList.contains('text-theme-brand')`,
        );
        await observe("saved", true);
        checkDiagnostics();
        await page.click(editSelector);
        await page.poll(
          "!!document.querySelector('.toast-viewer.toastui-editor-contents')",
        );
        completed++;
        console.log(`ok: ${phase} view/clean/dirty/saved`);
      }
    }
  }
  assert(completed === 8, `all eight matrix cases ran, got ${completed}`);
  checkDiagnostics();
} catch (error) {
  failure = error;
} finally {
  let preserve = false;
  if (pendingMarker) {
    try {
      await savePending();
    } catch (error) {
      preserve = true;
      failure = new AggregateError(
        [failure, error].filter(Boolean),
        "probe failed; dirty fixture retained",
      );
      console.error(
        `Unsaved fixture retained at ${vault}, app ${server?.baseUrl}, target ${targetId}`,
      );
    }
  }
  try {
    await Deno.writeTextFile(
      join(artifacts, "diagnostics.json"),
      JSON.stringify(
        {
          events,
          stages,
          targetId,
          baseUrl: server?.baseUrl,
          pageErrors: page?.pageErrors ?? [],
          completed,
          failure: failure?.message,
        },
        null,
        2,
      ),
    );
    await Deno.writeTextFile(
      join(artifacts, "measurements.json"),
      JSON.stringify(measurements, null, 2),
    );
  } finally {
    if (preserve) { page?.page.close(); page?.browser.close(); }
    else { try { await page?.close(); } finally { await server?.close(); } }
    console.log(`button-icons artifacts: ${artifacts}`);
  }
}
if (failure) throw failure;
console.log("BUTTON ICONS OK");
