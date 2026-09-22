// First-run wizard e2e probe (plan §6.2): geometry stability, viewport
// matrix, keyboard/accessibility, pending/failure, and per-mode outcomes —
// each against its own fresh server + vault, one browser it owns.
// Prints the artifact dir and "SETUP WIZARD OK" only when all pass.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { join } from "node:path";

const CDP_PORT = Number(process.env.CDP_PORT || 9399);
const ARTIFACTS = await Deno.makeTempDir({ prefix: "setup-wizard-shots-" });

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
    throw new Error(msg);
  }
  console.log(`ok: ${msg}`);
}

function rectList(expr) {
  return `(() => {
    const pick = (name, el) => {
      const r = el.getBoundingClientRect();
      return { name, x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const dialog = document.querySelector("[role=dialog]");
    const rows = [...document.querySelectorAll("input[name=access-mode]")]
      .map((i) => i.closest("label"));
    const details = document.querySelector("form .setup-details");
    const finish = document.querySelector("button[type=submit]");
    return [
      pick("dialog", dialog),
      ...rows.map((el, i) => pick("row" + i, el)),
      pick("details", details),
      pick("finish", finish),
    ];
  })()`;
}

function compareRects(a, b, label) {
  for (const ra of a) {
    const rb = b.find((r) => r.name === ra.name);
    for (const k of ["x", "y", "w", "h"]) {
      const d = Math.abs(ra[k] - rb[k]);
      assert(
        d <= 0.5,
        `${label}: ${ra.name}.${k} stable (Δ${d.toFixed(3)}px)`,
      );
    }
  }
}

async function twoFrames(page) {
  await page.evaluate(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  );
}

async function selectMode(page, value) {
  await page.click(`input[name=access-mode][value=${value}]`);
  await page.poll(
    `document.querySelector('input[name=access-mode][value=${value}]').checked`,
  );
}

async function fillField(page, selector, value) {
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

async function geometrySweep(page, baseUrl, viewport) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.w, height: viewport.h, deviceScaleFactor: 1, mobile: false,
  });
  await page.goto(`${baseUrl}/`);
  await page.poll(`document.querySelector("[role=dialog]") !== null`);
  await page.evaluate(`window.scrollTo(0, 0)`);
  await twoFrames(page);

  const settled = {};
  for (const mode of ["password", "read_only", "none", "password"]) {
    await selectMode(page, mode);
    // Normalize the dialog's internal scroll before comparing: at short
    // viewports the click's scrollIntoView shifts rects without any layout
    // change — a scroll position is not a layout jump (plan §6.2 note).
    await page.evaluate(
      `document.querySelector("[role=dialog]").scrollTop = 0`,
    );
    // Intermediate frames: measure right after the input lands, and after
    // two rAFs — both must equal the settled geometry (no animation).
    const mid = await page.evaluate(rectList());
    await twoFrames(page);
    const end = await page.evaluate(rectList());
    compareRects(mid, end, `mid-frame (${viewport.w}x${viewport.h}, ${mode})`);
    if (settled.prev) {
      compareRects(settled.prev, end, `mode→${mode} (${viewport.w}x${viewport.h})`);
    }
    settled.prev = end;
  }

  const overflow = await page.evaluate(
    `document.documentElement.scrollWidth - window.innerWidth`,
  );
  assert(overflow <= 0, `no horizontal overflow at ${viewport.w}x${viewport.h}`);
  const finishVisible = await page.evaluate(`(() => {
    const r = document.querySelector("button[type=submit]").getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`);
  assert(finishVisible, `finish reachable at ${viewport.w}x${viewport.h}`);
}

const servers = [];
let browser = null;
try {
  // Fixture vaults are caller-owned (written before boot, cleaned in finally).
  const vaultA = await Deno.makeTempDir({ prefix: "wizard-vault-a-" });
  const vaultB = await Deno.makeTempDir({ prefix: "wizard-vault-b-" });
  const vaultC = await Deno.makeTempDir({ prefix: "wizard-vault-c-" });
  await Deno.writeTextFile(join(vaultA, "FixtureA.md"), "# Fixture A\n\nalpha\n");
  await Deno.writeTextFile(join(vaultB, "FixtureB.md"), "# Fixture B\n\nbravo\n");

  // No auth env anywhere — the wizard must fire on every server.
  servers.push(await bootServer({ GLOBNOTES_PATH: vaultA }));
  servers.push(await bootServer({ GLOBNOTES_PATH: vaultB }));
  servers.push(await bootServer({ GLOBNOTES_PATH: vaultC }));
  const [A, B, C] = servers;
  for (const s of servers) {
    const setup = await (await fetch(`${s.baseUrl}/_/api/setup`)).json();
    assert(setup.setupRequired === true, `wizard armed on ${s.baseUrl}`);
  }

  browser = await launchBrowser({ port: CDP_PORT });
  const page = await connect({ port: CDP_PORT });

  // -- 1. Geometry stability across the viewport matrix ---------------------
  for (const viewport of [
    { w: 1280, h: 900 },
    { w: 390, h: 844 },
    { w: 320, h: 568 },
    { w: 844, h: 390 },
  ]) {
    await geometrySweep(page, A.baseUrl, viewport);
  }
  await page.screenshot(join(ARTIFACTS, "wizard-password.png"));
  await selectMode(page, "read_only");
  await page.screenshot(join(ARTIFACTS, "wizard-readonly.png"));
  await selectMode(page, "none");
  await page.screenshot(join(ARTIFACTS, "wizard-open.png"));
  await selectMode(page, "password");

  // -- 2. Keyboard: Tab containment within the dialog -----------------------
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await page.goto(`${A.baseUrl}/`);
  await page.poll(`document.querySelector("[role=dialog]") !== null`);
  // Focus starts on the selected radio.
  const focusedRadio = await page.evaluate(
    `document.activeElement && document.activeElement.value`,
  );
  assert(focusedRadio === "password", "initial focus on the selected radio");
  // Tab cycles: collect focus order for two full cycles — never leaves dialog.
  for (let i = 0; i < 14; i++) {
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
    });
    const inside = await page.evaluate(
      `document.querySelector("[role=dialog]").contains(document.activeElement)`,
    );
    assert(inside, `Tab containment holds (step ${i + 1})`);
  }
  // Arrow keys move the radio selection natively (focus must be on the group).
  await page.evaluate(
    `document.querySelector('input[name=access-mode][value=password]').focus()`,
  );
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
  });
  await page.poll(
    `document.querySelector('input[name=access-mode][value=read_only]').checked`,
  );
  console.log("ok: arrow-key radio selection");
  await selectMode(page, "password");

  // -- 3. Pending + failure with a controlled request -----------------------
  await fillField(page, "#setup-username", "wizard-user");
  await fillField(page, "#setup-password", "wizard-pass");
  const finishBefore = await page.evaluate(`(() => {
    const r = document.querySelector("button[type=submit]").getBoundingClientRect();
    return { w: r.width, h: r.height };
  })()`);

  let intercepted = 0;
  let interceptMode = "fail"; // "fail" → "slow" → "off" (single handler, no leaks)
  let slowRelease;
  const slowWait = new Promise((r) => (slowRelease = r));
  page.onEvent((msg) => {
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    if (!request.url.includes("/_/api/setup")) {
      page.send("Fetch.continueRequest", { requestId });
      return;
    }
    if (interceptMode === "fail") {
      intercepted++;
      page.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    } else if (interceptMode === "slow") {
      slowWait.then(() =>
        page.send("Fetch.continueRequest", { requestId })
      );
    } else {
      page.send("Fetch.continueRequest", { requestId });
    }
  });
  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });

  await page.click("button[type=submit]");
  await page.poll(
    `document.querySelector("p[role=alert]").textContent.includes("Setup failed")`,
  );
  assert(intercepted === 1, "exactly one setup request made");
  const finishAfter = await page.evaluate(`(() => {
    const r = document.querySelector("button[type=submit]").getBoundingClientRect();
    return { w: r.width, h: r.height };
  })()`);
  assert(
    Math.abs(finishBefore.w - finishAfter.w) <= 0.5 &&
      Math.abs(finishBefore.h - finishAfter.h) <= 0.5,
    "finish button size stable through failure",
  );
  const retained = await page.evaluate(
    `document.querySelector("#setup-username").value`,
  );
  assert(retained === "wizard-user", "credentials retained after failure");
  await page.screenshot(join(ARTIFACTS, "wizard-failure.png"));

  // Retry: hold the request mid-flight to observe the busy state.
  interceptMode = "slow";
  await page.click("button[type=submit]");
  await page.poll(
    `document.querySelector("button[type=submit]").textContent.includes("Setting up")`,
  );
  const busyDisabled = await page.evaluate(
    `document.querySelector("button[type=submit]").disabled`,
  );
  assert(busyDisabled, "busy state disables the action");
  slowRelease();
  interceptMode = "off";

  // -- 4. Password outcome: login, fixture access, guarded data -------------
  // The held request continuing IS the completion path — routing to login
  // proves it landed; only then is the Fetch domain safe to disable.
  await page.poll(`location.pathname.includes("/_/login")`, { timeout: 15000 });
  await page.send("Fetch.disable");
  console.log("ok: routed to login after password setup (no reload)");
  await fillField(page, "#username", "wizard-user");
  await fillField(page, "#password", "wizard-pass");
  await page.clickText("Log In");
  // Gate on the post-login route change — content-column exists on every
  // page (including login), so it can't prove sign-in; the URL can.
  await page.poll(`!location.pathname.includes("/_/login")`, {
    timeout: 10000,
  });
  console.log("ok: signed in with the new credentials");
  await page.goto(`${A.baseUrl}/FixtureA`);
  await page.poll(`document.body.textContent.includes("alpha")`);
  console.log("ok: fixture note readable after login");
  // Edit via the API with the session token (proves authenticated mutation).
  const edited = await page.evaluate(`(async () => {
    const r = await fetch("/_/api/notes/FixtureA", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPath: "FixtureA", newContent: "# Fixture A\\n\\nalpha edited\\n" }),
    });
    return r.status;
  })()`);
  assert(edited === 200, "authenticated edit succeeds");
  // Unauthenticated client cannot read protected data.
  const anon = await fetch(`${A.baseUrl}/_/api/notes/FixtureA`);
  assert(anon.status === 401, "unauthenticated read rejected (401)");
  // Persistence: reload must not bring the wizard back.
  await page.reload();
  await page.poll(`document.querySelector(".content-column") !== null`);
  const wizardBack = await page.evaluate(
    `document.querySelector("[role=dialog]") !== null`,
  );
  assert(!wizardBack, "setup does not return after completion");

  // -- 5. Read-only outcome ---------------------------------------------------
  await page.goto(`${B.baseUrl}/`);
  await page.poll(`document.querySelector("[role=dialog]") !== null`);
  await selectMode(page, "read_only");
  await page.click("button[type=submit]");
  await page.poll(`!location.pathname.includes("/_/login")`, { timeout: 15000 });
  await page.poll(`document.querySelector(".content-column") !== null`);
  console.log("ok: read-only setup lands in the app (no sign-in)");
  await page.goto(`${B.baseUrl}/FixtureB`);
  await page.poll(`document.body.textContent.includes("bravo")`);
  console.log("ok: read-only can browse the fixture");
  const editControls = await page.evaluate(
    `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Edit")`,
  );
  assert(!editControls, "no editing controls in read-only mode");
  const roWrite = await page.evaluate(`(async () => {
    const r = await fetch("/_/api/notes/FixtureB", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPath: "FixtureB", newContent: "nope" }),
    });
    return r.status;
  })()`);
  assert(roWrite === 403, "direct mutation rejected in read-only (403)");
  const fixtureB = await Deno.readTextFile(join(vaultB, "FixtureB.md"));
  assert(fixtureB.includes("bravo"), "fixture unmodified by the attempt");
  await page.goto(`${B.baseUrl}/_/search?term=Fixture`);
  await page.poll(`document.body.textContent.includes("Fixture B")`);
  console.log("ok: read-only can search");
  await page.screenshot(join(ARTIFACTS, "wizard-readonly-outcome.png"));

  // -- 6. Open-access outcome -------------------------------------------------
  await page.goto(`${C.baseUrl}/`);
  await page.poll(`document.querySelector("[role=dialog]") !== null`);
  await selectMode(page, "none");
  // Finish stays disabled until the acknowledgement is checked.
  const disabledBefore = await page.evaluate(
    `document.querySelector("button[type=submit]").disabled`,
  );
  assert(disabledBefore, "finish disabled until open-access acknowledgement");
  await page.click("input[type=checkbox]");
  const disabledAfter = await page.evaluate(
    `document.querySelector("button[type=submit]").disabled`,
  );
  assert(!disabledAfter, "finish enabled once acknowledged");
  await page.click("button[type=submit]");
  await page.poll(`document.querySelector(".content-column") !== null`, {
    timeout: 15000,
  });
  console.log("ok: open access lands in the app without sign-in");
  // Create via the real UI path.
  await page.click('button[title="New note"]');
  await page.poll(`location.pathname.includes("/_/new")`);
  await fillField(page, "input[placeholder=Title]", "WizardOpen");
  await page.clickText("Save");
  await page.poll(`location.pathname.includes("WizardOpen")`);
  console.log("ok: open access creates a note via UI");
  // After save the note shows in view mode — toggle Edit, then type into the
  // actual editable element (CodeMirror .cm-content / .ProseMirror, NOT the
  // view-mode preview div).
  await page.clickText("Edit");
  await page.poll(
    `document.querySelector(".cm-content, .ProseMirror") !== null`,
  );
  await page.evaluate(`(() => {
    const el = document.querySelector(".cm-content, .ProseMirror");
    el.focus();
    return true;
  })()`);
  await page.send("Input.insertText", { text: " edited-open" });
  await page.clickText("Save");
  await page.poll(`document.body.textContent.includes("edited-open")`, {
    timeout: 8000,
  });
  console.log("ok: open access edits a note via UI");
  // Delete via UI.
  await page.clickText("Delete");
  await page.waitForTimeout(400);
  await page.clickText("Delete");
  await page.poll(`!location.pathname.includes("WizardOpen")`, {
    timeout: 8000,
  });
  const gone = await page.evaluate(
    `!document.querySelector("aside")?.textContent.includes("WizardOpen")`,
  );
  assert(gone, "open access deletes a note via UI");

  console.log(`\nartifacts: ${ARTIFACTS}`);
  console.log("SETUP WIZARD OK");
} finally {
  if (browser) await stopBrowser(browser);
  for (const s of servers) await s.close();
  if (failures > 0) {
    console.error(`setup-wizard: ${failures} assertion(s) failed`);
    Deno.exit(1);
  }
}
