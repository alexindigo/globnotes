// Desktop-only TOTP wizard acceptance: actual layout, switch/QR activation,
// and clipboard outcome. Run in the test VM, never on the host.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { join } from "node:path";
import { authenticatorCode } from "../../../tests/helpers/totp.ts";
import { captureClipboard, restoreClipboard } from "./native-clipboard.mjs";

const externalBrowser = Deno.env.get("CDP_PORT");
const port = Number(externalBrowser || 9398);
const artifacts = await Deno.makeTempDir({ prefix: "totp-desktop-shots-" });
const server = await bootServer({});
let browser;
let page;
let priorClipboard;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok: ${message}`);
}

function stable(before, after, label) {
  for (const [name, rect] of Object.entries(before)) {
    // The action follows intrinsic content vertically; shell() proves its
    // feedback-lane ordering on every observation, and fit() proves reachability.
    const axes = name === "finish" ? ["x", "w", "h"] : ["x", "y", "w", "h"];
    for (const key of axes) {
      assert(
        Math.abs(rect[key] - after[name][key]) <= 0.5,
        `${label}: ${name}.${key} stable`,
      );
    }
  }
}

async function shell() {
  return await page.evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    if(document.querySelector('button[type=submit]').getBoundingClientRect().top<dialog.querySelector('form > p[role=alert]').getBoundingClientRect().bottom)throw Error('Finish overlaps or precedes its feedback lane');
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y + (el===dialog ? 0 : dialog.scrollTop), w: r.width, h: r.height };
    };
    return Object.fromEntries([
      ['dialog', document.querySelector('[role=dialog]')],
      ['finish', document.querySelector('button[type=submit]')],
      ...[...document.querySelectorAll('input[name=access-mode]')]
        .map((el, i) => ['choice' + i, el.closest('label')]),
    ].map(([name, el]) => [name, rect(el)]));
  })()`);
}

async function fit(label) {
  const measured = await page.evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    const qr = document.querySelector('#setup-totp-qr img');
    const qrLane = qr.parentElement.parentElement;
    const fields = document.querySelector('.setup-totp-fields');
    const row = document.querySelector('.setup-totp-enrolment');
    const input = document.querySelector('#setup-totp-code');
    const footer = document.querySelector('button[type=submit]');
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height,
        right: r.right, bottom: r.bottom };
    };
    const r = rect(footer);
    return {
      qr: rect(qr), qrLane: rect(qrLane), fields: rect(fields), row: rect(row), input: rect(input),
      footer: r, dialog: rect(dialog), feedback: rect(document.querySelector('form > p[role=alert]')),
      authenticatorGap: document.querySelector('#setup-totp-label')
        .parentElement.parentElement.getBoundingClientRect().top -
        document.querySelector('#setup-password').getBoundingClientRect().bottom,
      enrolmentGap: row.getBoundingClientRect().top - document.querySelector('#setup-totp-label')
        .parentElement.parentElement.getBoundingClientRect().bottom,
      verticalOverflow: dialog.scrollHeight - dialog.clientHeight,
      horizontalOverflow: dialog.scrollWidth - dialog.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      footerHit: footer.contains(document.elementFromPoint(
        r.x + r.w / 2, r.y + r.h / 2)),
      tooltip: document.querySelector('[role=tooltip]')
        ? rect(document.querySelector('[role=tooltip]')) : null,
    };
  })()`);
  const { qr, qrLane, fields, row, input, footer, dialog } = measured;
  assert(
    measured.authenticatorGap >= 16,
    `${label}: authenticator row has breathing room`,
  );
  assert(
    measured.enrolmentGap >= 16,
    `${label}: spacing below authenticator row`,
  );
  assert(qr.w === 224 && qr.h === 224, `${label}: QR is 224px square`);
  assert(
    fields.x >= qr.right && input.x >= qr.right,
    `${label}: input beside QR`,
  );
  assert(
    Math.abs(fields.y + fields.h / 2 - (qrLane.y + qrLane.h / 2)) <= 0.5,
    `${label}: adjacent content shares the QR/feedback lane centerline`,
  );
  assert(
    fields.y >= qrLane.y && fields.bottom <= qrLane.bottom && Math.abs(row.h-Math.max(qrLane.h,fields.h))<=0.5,
    `${label}: enrolment row contains its complete intrinsic lanes`,
  );
  assert(
    input.right <= dialog.right && row.bottom < footer.y && measured.feedback.bottom <= footer.y,
    `${label}: no overlap`,
  );
  if (measured.tooltip) {
    assert(
      measured.tooltip.y >= qr.bottom && measured.tooltip.x >= qr.x &&
        measured.tooltip.right <= qr.right && measured.tooltip.bottom <= qrLane.bottom,
      `${label}: feedback follows QR within its own lane without covering fields`,
    );
  }
  assert(
    measured.horizontalOverflow <= 1 &&
      measured.documentOverflow <= 0,
    `${label}: no horizontal escape`,
  );
  const reachable = await page.evaluate("(async()=>{const dialog=document.querySelector('[role=dialog]'),footer=document.querySelector('button[type=submit]'),before=dialog.scrollTop;footer.scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=footer.getBoundingClientRect(),d=dialog.getBoundingClientRect(),hit=footer.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));const result={hit,inside:r.top>=d.top&&r.bottom<=d.bottom&&r.bottom<=innerHeight,scrollTop:dialog.scrollTop};dialog.scrollTop=before;return result;})()");
  assert(reachable.hit && reachable.inside, `${label}: Finish reachable and unobscured`);
  measured.reachableFooter = reachable;
  console.log(JSON.stringify({ label, measured }));
}

try {
  if (!externalBrowser) browser = await launchBrowser({ port });
  page = await connect({ port, binding: browser });
  await page.send("Network.enable");
  let bundle;
  let heldEnrolment;
  const enrolmentRequests = new Set();
  page.onEvent((event) => {
    if (event.method === "Fetch.requestPaused") {
      heldEnrolment = event.params.requestId;
    }
    if (
      event.method === "Network.responseReceived" &&
      event.params.response.url.endsWith("/_/api/setup/totp-enrolment")
    ) enrolmentRequests.add(event.params.requestId);
    if (
      event.method === "Network.loadingFinished" &&
      enrolmentRequests.delete(event.params.requestId)
    ) {
      page.send("Network.getResponseBody", {
        requestId: event.params.requestId,
      })
        .then(({ body }) => {
          bundle = JSON.parse(body);
        });
    }
  });

  for (
    const size of [{ w: 1280, h: 900 }, { w: 1366, h: 768 }, {
      w: 1920,
      h: 1080,
    }]
  ) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: size.w,
      height: size.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await page.goto(server.baseUrl);
      await page.evaluate(
        `localStorage.setItem('globnotes-theme', 'globnotes-${theme}')`,
      );
      await page.reload();
      await page.poll("document.querySelector('#setup-totp') !== null");
      await page.evaluate("document.fonts.ready");
      assert(
        await page.evaluate(
          `document.body.classList.contains('dark') === ${theme === "dark"}`,
        ),
        `${theme} theme applied`,
      );
      const label = `${size.w}x${size.h}-${theme}`;
      const before = await shell();
      assert(
        await page.evaluate(
          "document.querySelector('#setup-totp').getAttribute('role') === 'switch'",
        ),
        `${label}: actual switch`,
      );
      bundle = null;
      heldEnrolment = null;
      await page.send("Fetch.enable", {
        patterns: [{
          urlPattern: "*/_/api/setup/totp-enrolment",
          requestStage: "Request",
        }],
      });
      await page.click("#setup-totp");
      await page.poll(
        "document.querySelector('.setup-totp-enrolment')?.textContent.includes('Generating')",
      );
      stable(before, await shell(), `${label} loading`);
      const loadingDeadline = Date.now() + 5000;
      while (!heldEnrolment && Date.now() < loadingDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert(
        heldEnrolment,
        `${label}: enrolment request held for loading check`,
      );
      await page.send("Fetch.continueRequest", { requestId: heldEnrolment });
      await page.send("Fetch.disable");
      await page.poll(
        "document.querySelector('#setup-totp-qr img')?.complete && document.querySelector('#setup-totp-qr img')?.naturalWidth > 0",
      );
      const deadline = Date.now() + 5000;
      while (!bundle && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert(bundle?.secret, `${label}: observed enrolment response`);
      assert(
        await page.evaluate(
          `!document.querySelector('[role=dialog]').textContent.includes(${
            JSON.stringify(bundle.secret)
          })`,
        ),
        `${label}: setup key not displayed`,
      );
      stable(before, await shell(), `${label} toggle-on`);
      await fit(label);
      await page.screenshot(join(artifacts, `${label}-ready.png`));

      await page.grantClipboard(server.baseUrl);
      if (priorClipboard === undefined) priorClipboard = await captureClipboard(page);
      await page.evaluate(
        "navigator.clipboard.writeText('clipboard-before-confirmation')",
      );
      await page.click("#setup-totp-qr");
      await page.poll(
        "document.querySelector('[role=tooltip]')?.textContent.includes('Click again')",
      );
      assert(
        await page.readClipboard() === "clipboard-before-confirmation",
        `${label}: first click only confirms`,
      );
      stable(before, await shell(), `${label} confirmation`);
      await fit(`${label} confirmation`);
      await page.screenshot(join(artifacts, `${label}-confirmation.png`));
      await page.click("#setup-totp-qr");
      await page.poll(
        "document.querySelector('[role=tooltip]')?.textContent.includes('Setup key copied')",
      );
      assert(
        await page.readClipboard() === bundle.secret,
        `${label}: actual clipboard receives base32 key`,
      );
      await page.evaluate(
        "navigator.clipboard.writeText('clipboard-after-copy')",
      );
      await page.click("#setup-totp-qr");
      await page.poll(
        "document.querySelector('[role=tooltip]')?.textContent.includes('Click again')",
      );
      assert(
        await page.readClipboard() === "clipboard-after-copy",
        `${label}: confirmation counter reset`,
      );

      await page.click("button[type=submit]");
      await page.poll(
        "document.querySelector('p[role=alert]')?.textContent.length > 0",
      );
      stable(before, await shell(), `${label} validation`);
      await fit(`${label} validation`);
      await page.screenshot(join(artifacts, `${label}-error.png`));

      for (const mode of ["read_only", "none", "password"]) {
        await page.click(`input[name=access-mode][value=${mode}]`);
        await page.poll(
          `document.querySelector('input[name=access-mode][value=${mode}]').checked`,
        );
        stable(before, await shell(), `${label} mode-${mode}`);
      }
      await page.click("#setup-totp-qr");
      await page.poll(
        "document.querySelector('[role=tooltip]')?.textContent.includes('Click again')",
      );
      // Native keyboard activation uses the same two-click confirmation flow.
      await page.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      });
      await page.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await page.poll(
        "document.querySelector('[role=tooltip]')?.textContent.includes('Setup key copied')",
      );
      assert(
        await page.readClipboard() === bundle.secret,
        `${label}: keyboard copies the same key`,
      );
      assert(
        (await (await fetch(`${server.baseUrl}/_/api/setup`)).json())
          .setupRequired,
        `${label}: non-submit buttons never complete setup`,
      );
      assert(
        page.pageErrors.length === 0,
        `${label}: no unexpected browser exceptions`,
      );
    }
  }
  // Finish through the real UI on the probe's own disposable vault, then
  // prove the resulting session at the authenticated consumer endpoint.
  const codeAt = (epoch) => authenticatorCode(bundle.secret, epoch);
  await page.fill("#setup-username", "desktop-user");
  await page.fill("#setup-password", "desktop-password");
  const validCodes = new Set(
    await Promise.all(
      [-30000, 0, 30000].map((offset) => codeAt(Date.now() + offset)),
    ),
  );
  let wrongCode = 0;
  while (validCodes.has(String(wrongCode).padStart(6, "0"))) wrongCode++;
  await page.fill("#setup-totp-code", String(wrongCode).padStart(6, "0"));
  await page.click("button[type=submit]");
  await page.poll(
    "document.querySelector('p[role=alert]')?.textContent.includes('That code')",
  );
  await page.poll("document.querySelector('#setup-totp-code')?.value === ''");
  await fit("server rejected code");
  await page.screenshot(join(artifacts, "server-code-error.png"));
  await page.fill("#setup-totp-code", await codeAt(Date.now()));
  await page.click("button[type=submit]");
  await page.poll(
    "location.pathname.includes('/_/login') && !document.querySelector('[role=dialog]')",
  );
  await page.fill("#username", "desktop-user");
  await page.fill("#password", "desktop-password");
  // The enrolment code is spent; use the adjacent allowed step at login.
  await page.fill("#one-time-code", await codeAt(Date.now() + 30000));
  await page.clickText("Log In");
  await page.poll("!location.pathname.includes('/_/login')");
  assert(
    await page.evaluate("fetch('/_/api/auth-check').then(r => r.status)") ===
      200,
    "wizard TOTP setup and UI login yield authenticated access",
  );
  assert(
    page.pageErrors.length === 0,
    "completed flow has no unexpected browser exceptions",
  );
  console.log(`artifacts: ${artifacts}`);
  console.log("TOTP DESKTOP OK");
} finally {
  try { if (priorClipboard !== undefined) await restoreClipboard(page, priorClipboard); }
  finally {
    await page?.close();
    if (browser) await stopBrowser(browser);
    await server.close();
    console.log("Retained TOTP fixture", server.vault);
  }
}
