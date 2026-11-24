// First-run wizard e2e probe (plan §6.2): geometry stability, viewport
// matrix, keyboard/accessibility, pending/failure, and per-mode outcomes —
// each against its own fresh server + vault, one browser it owns.
// Prints the artifact dir and "SETUP WIZARD OK" only when all pass.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { applicationServer } from "./http-origin.mjs";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { join } from "node:path";
import { finalizeNativeCase } from "./native-case-finalization.mjs";
import { assertToggleGeometry } from "./settings-frame-native.mjs";
import { identityTokenScope } from "../../../shared/identity_token.ts";

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
    const rows = [...document.querySelectorAll("input[name=identity-everybody]")]
      .map((i) => i.closest("label"));
    const details = document.querySelector("form .setup-columns");
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
  await assertToggleGeometry(page);
}

async function selectMode(page, value) {
  await page.click(`input[name=identity-everybody][value=${value}]`);
  await page.poll(
     `document.querySelector('input[name=identity-everybody][value=${value}]')?.checked`,
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
  for (const mode of ["none", "view", "edit", "none"]) {
    await selectMode(page, mode);
    // Normalize the dialog's internal scroll before comparing: at short
    // viewports the click's scrollIntoView shifts rects without any layout
    // change — a scroll position is not a layout jump (plan §6.2 note).
    await page.evaluate(
      `document.querySelector("[role=dialog]").scrollTop = 0`,
    );
    // Intermediate frames: measure right after the input lands, and after
    // two rAFs — both must equal the settled geometry (no animation).
     const mid = await page.read(['[role=dialog]', 'form .setup-columns', 'button[type=submit]'], rectList());
    await twoFrames(page);
     const end = await page.read(['[role=dialog]', 'form .setup-columns', 'button[type=submit]'], rectList());
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
   const finishVisible = await page.read('button[type=submit]', `(() => {
    const r = document.querySelector("button[type=submit]").getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`);
  assert(finishVisible, `finish reachable at ${viewport.w}x${viewport.h}`);
}

const servers = [];
let browser = null;
let failure;
try {
  // Fixture vaults are caller-owned (written before boot, cleaned in finally).
  const vaultA = await Deno.makeTempDir({ prefix: "wizard-vault-a-" });
  const vaultB = await Deno.makeTempDir({ prefix: "wizard-vault-b-" });
  const vaultC = await Deno.makeTempDir({ prefix: "wizard-vault-c-" });
  await Deno.writeTextFile(join(vaultA, "FixtureA.md"), "# Fixture A\n\nalpha\n");
  await Deno.writeTextFile(join(vaultB, "FixtureB.md"), "# Fixture B\n\nbravo\n");

  // No auth env anywhere — the wizard must fire on every server.
  servers.push(await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vaultA }, applicationServer()));
  servers.push(await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vaultB }, applicationServer()));
  servers.push(await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vaultC }, applicationServer()));
  const [A, B, C] = servers;
  for (const s of servers) {
    const setup = await (await fetch(`${s.baseUrl}/_/api/setup`)).json();
    assert(setup.setupRequired === true, `wizard armed on ${s.baseUrl}`);
  }

  browser = await launchBrowser({ port: CDP_PORT });
  const page = await connect({ port: CDP_PORT, binding: browser });

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
  await selectMode(page, "view");
  await page.screenshot(join(ARTIFACTS, "wizard-readonly.png"));
  await selectMode(page, "edit");
  await page.screenshot(join(ARTIFACTS, "wizard-open.png"));
  await selectMode(page, "none");

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
  assert(focusedRadio === "view", "initial focus on the default View radio");
  // Tab cycles: collect focus order for two full cycles — never leaves dialog.
  for (let i = 0; i < 14; i++) {
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
    });
    const inside = await page.evaluate(
       `document.querySelector("[role=dialog]")?.contains(document.activeElement)`,
    );
    assert(inside, `Tab containment holds (step ${i + 1})`);
  }
  // Arrow keys move the radio selection natively (focus must be on the group).
  await page.evaluate(
    `document.querySelector('input[name=identity-everybody][value=edit]').focus()`,
  );
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
  });
  await page.poll(
     `document.querySelector('input[name=identity-everybody][value=view]')?.checked`,
  );
  console.log("ok: arrow-key radio selection");
  await selectMode(page, "none");

  // -- 3. Pending + failure with a controlled request -----------------------
  await fillField(page, "#setup-login", "wizard-user");
  await fillField(page, "#setup-password", "wizard-pass");
   const finishBefore = await page.read('button[type=submit]', `(() => {
    const r = document.querySelector("button[type=submit]").getBoundingClientRect();
    return { w: r.width, h: r.height };
  })()`);

  let intercepted = 0;
  let interceptMode = "fail"; // "fail" → "slow" → "off" (single handler, no leaks)
  let slowRelease;
  const slowWait = new Promise((r) => (slowRelease = r));
  // Paused-request events can still arrive after Fetch.disable; Chrome releases
  // those requests itself, so a reply then is neither needed nor an error.
  let intercepting = true;
  const reply = (method, params) =>
    page.send(method, params).catch((error) => {
      if (intercepting) throw error;
    });
  page.onEvent((msg) => {
    if (msg.method !== "Fetch.requestPaused" || !intercepting) return;
    const { requestId, request } = msg.params;
    if (request.method !== "POST" || !request.url.endsWith("/_/api/setup")) {
      reply("Fetch.continueRequest", { requestId });
      return;
    }
    if (interceptMode === "fail") {
      intercepted++;
      reply("Fetch.failRequest", { requestId, errorReason: "Failed" });
    } else if (interceptMode === "slow") {
      slowWait.then(() => reply("Fetch.continueRequest", { requestId }));
    } else {
      reply("Fetch.continueRequest", { requestId });
    }
  });
  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });

  await page.click("button[type=submit]");
  await page.poll(
     `document.querySelector("p[role=alert]")?.textContent.includes("Connection lost")`,
  );
  assert(intercepted === 1, "exactly one setup request made");
   const finishAfter = await page.read('button[type=submit]', `(() => {
    const r = document.querySelector("button[type=submit]").getBoundingClientRect();
    return { w: r.width, h: r.height };
  })()`);
  assert(
    Math.abs(finishBefore.w - finishAfter.w) <= 0.5 &&
      Math.abs(finishBefore.h - finishAfter.h) <= 0.5,
    "finish button size stable through failure",
  );
  const retained = await page.evaluate(
     `document.querySelector("#setup-login")?.value`,
  );
  assert(retained === "wizard-user", "credentials retained after failure");
  await page.screenshot(join(ARTIFACTS, "wizard-failure.png"));

  // Retry: hold the request mid-flight to observe the busy state.
  interceptMode = "slow";
  await page.click("button[type=submit]");
  await page.poll(
     `document.querySelector(".identity-setup [role=status]")?.textContent.includes("Finishing setup")`,
  );
   const busyDisabled = await page.read('.identity-setup [role=status]',
    `document.querySelector(".identity-setup button[type=submit]") === null`,
  );
  assert(busyDisabled, "busy state disables the action");
  slowRelease();
  interceptMode = "off";

  // -- 4. Private setup: the same request signs the new Admin in and opens notes.
  await page.poll(`location.pathname === '/' && !document.querySelector('.identity-setup')`, { timeout: 15000 });
  intercepting = false;
  await page.send("Fetch.disable");
  await page.poll(`fetch('/_/api/auth-check').then(r=>r.json()).then(s=>s.principal.login==='wizard-user' && s.capabilities.canManageVault)`);
  console.log("ok: signed in when setup completed without reload");
  await page.goto(`${A.baseUrl}/FixtureA`);
  await page.poll(`document.body.textContent.includes("alpha")`);
  console.log("ok: fixture note readable after login");
  // Edit via the API with the session token (proves authenticated mutation).
  const edited = await page.evaluate(`(async () => {
    const read = await (await fetch("/_/api/notes/FixtureA")).json();
    const r = await fetch("/_/api/notes/FixtureA", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPath: "FixtureA", newContent: "# Fixture A\\n\\nalpha edited\\n", base: { kind: "version", version: read.version } }),
    });
    return r.status;
  })()`);
  assert(edited === 200, "authenticated edit succeeds");
  // Unauthenticated client cannot read protected data.
  const anon = await fetch(`${A.baseUrl}/_/api/notes/FixtureA`);
  assert(anon.status === 403, "Everybody else None denies an anonymous read");
  await anon.body?.cancel();
  // Persistence: reload must not bring the wizard back.
  await page.reload();
  await page.poll(`document.querySelector(".content-column") !== null`);
  const wizardBack = await page.evaluate(
    `document.querySelector("[role=dialog]") !== null`,
  );
  assert(!wizardBack, "setup does not return after completion");

  // -- 5. Read-only outcome ---------------------------------------------------
  // Different fixture ports share this browser's cookie scope. End A's
  // test session before navigating to the independent fresh install B.
  const clearSession = `(() => {sessionStorage.removeItem(${JSON.stringify(identityTokenScope("").key)}); document.cookie=${JSON.stringify(`${identityTokenScope("").cookieName}=; Path=/; Max-Age=0; SameSite=Strict`)};})()`;
  await page.evaluate(clearSession);
  await page.goto(`${B.baseUrl}/`);
  await page.poll(`document.querySelector("[role=dialog]") !== null`);
  await selectMode(page, "view");
  await fillField(page, "#setup-login", "view-owner");
  await fillField(page, "#setup-password", "view-password");
  await page.click("button[type=submit]");
  await page.poll(`location.pathname === '/' && !document.querySelector('.identity-setup')`, { timeout: 15000 });
  await page.poll(`document.querySelector(".content-column") !== null`);
  // Observe actual guest View without conflating it with the setup Admin.
  await page.evaluate(clearSession);
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
  await selectMode(page, "edit");
  await page.click("button[type=submit]");
  assert((await (await fetch(`${C.baseUrl}/_/api/setup`)).json()).setupRequired === true,
    "setup cannot complete before the owner supplies credentials");
  await fillField(page, "#setup-login", "edit-owner");
  await fillField(page, "#setup-password", "edit-password");
  await page.click("button[type=submit]");
  await page.poll(`location.pathname === '/' && !document.querySelector('.identity-setup')`, {
    timeout: 15000,
  });
  await page.evaluate(clearSession);
  await page.reload();
  await page.poll(`fetch('/_/api/auth-check').then(r=>r.json()).then(s=>s.principal.kind==='guest' && s.capabilities.canEdit)`);
  console.log("ok: Everybody else Edit gives guests note editing without signing in");
  // Create via the real UI path.
  await page.click('button[title="New note"]');
  await page.poll(`location.pathname.includes("/_/new")`);
  await fillField(page, "input[placeholder=Title]", "WizardOpen");
  await page.clickText("Save");
  await page.poll(`location.pathname.includes("WizardOpen")`);
  await page.poll("fetch('/_/api/notes/WizardOpen').then(r=>r.json()).then(note=>note.path==='WizardOpen')");
  console.log("ok: open access creates a note via UI");
  // Save keeps editing, including after creation; type into the actual editor.
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
  await page.poll(`fetch('/_/api/notes/WizardOpen').then(r=>r.json()).then(note=>note.content.includes('edited-open'))`, {
    timeout: 8000,
  });
  await page.poll("(()=>{const button=[...document.querySelectorAll('.content-column button')].find(el=>el.textContent.trim()==='Save');return button?.getAttribute('aria-busy')==='false'&&!document.querySelector('.content-column .animate-spin');})()");
  console.log("ok: open access edits a note via UI");
  // Delete via UI.
  await page.clickText("Delete");
  await page.poll("document.querySelector('[data-modal-top=true]')?.textContent.includes('Confirm Deletion')");
  await page.clickText("Delete");
  await page.poll(`location.pathname==='/'`, {
    timeout: 8000,
  });
  const response = await fetch(C.baseUrl + "/_/api/notes/WizardOpen");
  await response.body?.cancel();
  assert(response.status === 404, "open access deletes the exact note via UI/API");
  try { await Deno.stat(join(vaultC, "WizardOpen.md")); throw Error("Deleted note remains on disk"); }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }

  console.log(`\nartifacts: ${ARTIFACTS}`);
  console.log("SETUP WIZARD OK");
} catch (error) {
  failure = error;
  throw error;
} finally {
  await finalizeNativeCase({ error: failure, cleanup: [() => browser && stopBrowser(browser), ...servers.map(server => () => server.close())] });
  if (failures > 0) {
    console.error(`setup-wizard: ${failures} assertion(s) failed`);
  }
}
