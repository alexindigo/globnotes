// The existing native selection runs one-screen setup and Account enrollment.
import { assert, assertEquals } from "@std/assert";
import { bootServer } from "../../../tests/helpers/boot.ts";
import { fixtureScope } from "../../../tests/helpers/fixture_scope.ts";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { applicationServer } from "./http-origin.mjs";
import { connect, launchBrowser, stopBrowser } from "./cdp.mjs";
import { createNativeTotpClock } from "./native-totp-fixture.mjs";
import { captureClipboard, prepareClipboardWitness, restoreClipboard, writeClipboardText } from "./native-clipboard.mjs";

const login = "desktop-user", password = "desktop-password";
const setup = "/_/api/setup", account = "/_/api/account", enrollment = `${account}/totp-enrolment`;
const dialog = '[data-modal-top="true"] [role="dialog"]';
const apply = `${dialog} button[type=submit]`;
const nextCode = "#account-new-code", currentPassword = "#account-dialog-current-password";

await fixtureScope(async scope => {
  const external = Deno.env.get("CDP_PORT"), port = Number(external || 9398);
  const artifacts = await Deno.makeTempDir({ prefix: "account-totp-desktop-" });
  const clock = (await scope.acquire(() => createNativeTotpClock(artifacts), clock => clock.close())).value;
  const server = (await scope.acquire(() => bootServer({}, { ...applicationServer(), denoArgs: clock.denoArgs }), server => server.close())).value;
  const seed = "# Desktop account proof\n\nRead after authenticator sign-in.\n";
  await Deno.writeTextFile(`${server.vault}/Desktop proof.md`, seed);
  const browser = external ? undefined : (await scope.acquire(() => launchBrowser({ port }), stopBrowser)).value;
  const page = (await scope.acquire(() => connect({ port, binding: browser }), page => page.close())).value;
  await prepareClipboardWitness(page);
  const clipboard = await captureClipboard(page);
  scope.defer(() => restoreClipboard(page, clipboard));

  const wire = [];
  let held, error;
  const stop = page.onEvent(event => {
    const p = event.params;
    if (event.method === "Fetch.requestPaused") held = p.requestId;
    if (event.method === "Network.requestWillBeSent") {
      const path = new URL(p.request.url).pathname;
      if ([setup, account, enrollment].includes(path)) wire.push({ id: p.requestId, path, method: p.request.method });
    }
    const row = wire.find(row => row.id === p.requestId);
    if (!row) return;
    if (event.method === "Network.responseReceived") row.status = p.response.status;
    if (event.method === "Network.loadingFinished") {
      row.finished = true;
      if (row.path === enrollment) page.send("Network.getResponseBody", { requestId: row.id }).then(
        ({ body }) => { try { row.bundle = JSON.parse(body); } catch (cause) { error = cause; } },
        cause => { error = cause; },
      );
    }
  });
  scope.defer(stop);
  await page.send("Network.enable");
  const waitFor = (label, read) => waitUntil(() => {
    if (error) throw error;
    const value = read();
    return value ? done(value) : pending({ label });
  }, { label, intervalMs: 25 });
  const accountWrites = () => wire.filter(row => row.path === account && row.method === "PATCH");
  const setupWrites = () => wire.filter(row => row.path === setup && row.method === "POST");
  const accountStatus = () => page.evaluate(`fetch('${account}').then(async r => ({status:r.status,body:await r.json()}))`);
  const show = title => page.poll(`document.querySelector(${JSON.stringify(dialog + " h2")})?.textContent.trim() === ${JSON.stringify(title)}`);
  const at = (selector, value) => page.poll(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);

  await page.goto(server.baseUrl);
  await page.poll("!!document.querySelector('.identity-setup')");
  assertEquals(await page.evaluate("document.querySelector('input[name=identity-everybody]:checked')?.value"), "view");
  await page.click(".identity-setup button[type=submit]");
  assertEquals(setupWrites().length, 0, "Missing credentials must not submit setup");
  await page.fill("#setup-login", login);
  await page.fill("#setup-password", password);
  await page.click('input[name="identity-everybody"][value="none"]');
  await page.click(".identity-setup button[type=submit]");
  await page.poll("!document.querySelector('.identity-setup') && !location.pathname.includes('/_/login')");
  assertEquals(setupWrites().map(row => [row.status, row.finished]), [[200, true]]);
  assertEquals(wire.filter(row => row.path === enrollment).length, 0, "Account is created without enrolling an authenticator");
  const opened = await accountStatus();
  assertEquals([opened.status, opened.body.login, opened.body.totpEnabled], [200, login, false]);

  async function fit(label) {
    const measured = await page.read([`${dialog} .authenticator-qr`, nextCode, currentPassword, apply], `(() => {
      const dialog = document.querySelector(${JSON.stringify(dialog)});
      const row = dialog.querySelector('.authenticator-enrollment');
      const button = dialog.querySelector('button[type=submit]');
      const box = el => el.getBoundingClientRect().toJSON();
      const qr = box(row.querySelector('img')), fields = box(row.lastElementChild);
      const input = box(document.querySelector('${nextCode}'));
      const proof = box(document.querySelector('${currentPassword}').closest('.setting-row'));
      const alert = dialog.querySelector('form > [role=alert]');
      return { qr, fields, input, proof, row:box(row), button:box(button), dialog:box(dialog),
        feedback: alert ? box(alert) : null, horizontalOverflow:dialog.scrollWidth-dialog.clientWidth,
        documentOverflow:document.documentElement.scrollWidth-innerWidth };
    })()`);
    const { qr, fields, input, proof, row, button, feedback } = measured;
    assertEquals([qr.width, qr.height], [224, 224], `${label}: actual QR is 224px square`);
    assert(fields.left >= qr.right && input.left >= qr.right, `${label}: code is beside the QR`);
    assert(Math.abs((fields.top + fields.bottom - qr.top - qr.bottom) / 2) <= 0.5, `${label}: QR and fields share a centerline`);
    assert(Math.abs(row.height - Math.max(qr.height, fields.height)) <= 0.5 && fields.top >= row.top && fields.bottom <= row.bottom, `${label}: fields remain inside the enrollment row`);
    assert(proof.top - row.bottom >= 16 && button.top - proof.bottom >= 16, `${label}: enrollment and password rows have breathing room`);
    assert(input.right <= measured.dialog.right && (!feedback || feedback.bottom <= button.top), `${label}: action follows its feedback without overlapping`);
    assert(measured.horizontalOverflow <= 1 && measured.documentOverflow <= 0, `${label}: no horizontal escape`);
    const reachable = await page.evaluate(`(async () => {
      const button=document.querySelector(${JSON.stringify(apply)}), dialog=button.closest('[role=dialog]');
      button.scrollIntoView({block:'nearest'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const b=button.getBoundingClientRect(), d=dialog.getBoundingClientRect();
      return b.top>=d.top && b.bottom<=d.bottom && b.bottom<=innerHeight && button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));
    })()`);
    assert(reachable, `${label}: enrollment action remains reachable and unobscured`);
    return [button.x, button.width, button.height];
  }

  let bundle, actionGeometry;
  const sizes = [[1280, 900], [1366, 768], [1920, 1080]];
  for (const [width, height] of sizes) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      const label = `${width}x${height}-${theme}`;
      await page.evaluate(`localStorage.setItem('globnotes-theme','globnotes-${theme}')`);
      await page.goto(`${server.baseUrl}/_/account`);
      await page.poll(`document.body.classList.contains('dark') === ${theme === "dark"}`);
      await page.poll("document.querySelector('main')?.innerText.includes('Your account') && document.querySelector('main')?.innerText.includes('desktop-user')");
      await page.evaluate("document.fonts.ready");
      const count = wire.filter(row => row.path === enrollment).length;
      held = undefined;
      await page.send("Fetch.enable", { patterns: [{ urlPattern: `*${enrollment}`, requestStage: "Request" }] });
      try {
        await page.clickText("Add authenticator");
        await show("Add authenticator");
        await page.poll("document.querySelector('.authenticator-enrollment [role=status]')?.textContent.includes('Preparing your authenticator')");
        const requestId = await waitFor(`${label}: enrollment request held`, () => held);
        assertEquals(await page.evaluate("!!document.querySelector('.authenticator-qr')"), false, "No QR is shown before the issued candidate arrives");
        await page.send("Fetch.continueRequest", { requestId });
      } finally { await page.send("Fetch.disable"); }
      bundle = await waitFor(`${label}: enrollment receipt`, () => wire.filter(row => row.path === enrollment)[count]?.bundle);
      assertEquals(wire.filter(row => row.path === enrollment).slice(count).map(row => [row.method, row.status]), [["POST", 200]]);
      assert(typeof bundle.secret === "string" && bundle.secret.length > 0);
      await page.poll("document.querySelector('.authenticator-qr')?.complete && document.querySelector('.authenticator-qr').naturalWidth > 0");
      assertEquals(await page.evaluate("document.querySelector('.manual-key')?.textContent"), bundle.secret, "Manual key is the exact issued key");
      assert(!await page.evaluate(`document.querySelector('main').textContent.includes(${JSON.stringify(bundle.secret)})`), "Manual key is confined to the enrollment dialog");
      actionGeometry = await fit(label);
      await page.screenshot(`${artifacts}/${label}-ready.png`);

      await writeClipboardText(page, "desktop-copy-sentinel");
      assertEquals(await page.readClipboard(), "desktop-copy-sentinel", "Opening enrollment does not copy the key");
      await page.clickText("Copy setup key");
      await page.poll("document.querySelector('.authenticator-enrollment')?.textContent.includes('Setup key copied')");
      assertEquals(await page.readClipboard(), bundle.secret);
      assertEquals(await fit(`${label} copy feedback`), actionGeometry);
      await page.screenshot(`${artifacts}/${label}-copied.png`);
      await writeClipboardText(page, "desktop-keyboard-sentinel");
      await page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(dialog + " button")})).find(b=>b.textContent.trim()==='Copy setup key').focus()`);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      assertEquals(await page.readClipboard(), bundle.secret, "Keyboard activates another copy of the same key");
      await page.click(apply);
      assertEquals(await page.evaluate(`document.querySelector('${nextCode}').validity.valueMissing`), true);
      assertEquals(accountWrites().length, 0, "Copying and incomplete form submission do not change credentials");
      assertEquals(await accountStatus(), opened);
      assertEquals(page.pageErrors, []);
      if (width !== sizes.at(-1)[0] || theme !== "dark") {
        await page.click(`${dialog} [aria-label=Close]`);
        await page.poll("!document.querySelector('.authenticator-qr')");
      }
    }
  }

  const correct = await clock.code(bundle.secret);
  const acceptedCodes = new Set(await Promise.all([-1, 0, 1].map(offset => clock.code(bundle.secret, offset))));
  let wrong = 0;
  while (acceptedCodes.has(String(wrong).padStart(6, "0"))) wrong++;
  await page.fill(currentPassword, password);
  await page.fill(nextCode, String(wrong).padStart(6, "0"));
  await page.click(apply);
  await show("Change authenticator and log out?");
  assertEquals(accountWrites().length, 0, "Review does not submit credentials");
  await page.clickText("Change and log out");
  const declined = await waitFor("wrong Account code receipt", () => accountWrites()[0]?.finished && accountWrites()[0]);
  assertEquals(declined.status, 422);
  await show("Add authenticator");
  await page.poll(`document.querySelector(${JSON.stringify(dialog + " [role=alert]")})?.textContent.includes('Your credentials could not be changed')`);
  assertEquals(await fit("server rejected code"), actionGeometry);
  await page.screenshot(`${artifacts}/server-code-error.png`);
  assertEquals(await accountStatus(), opened, "Rejected code does not change the authenticator or account revision");

  await page.fill(nextCode, correct);
  await at(nextCode, correct);
  await page.click(apply);
  await show("Change authenticator and log out?");
  await page.clickText("Change and log out");
  const changed = await waitFor("confirmed Account enrollment receipt", () => accountWrites()[1]?.finished && accountWrites()[1]);
  assertEquals(changed.status, 200);
  await page.poll("location.pathname.includes('/_/login') && !!document.querySelector('#identity-login-name')");
  assertEquals((await accountStatus()).status, 401, "Credential change signs out the browser");
  await page.fill("#identity-login-name", login);
  await page.fill("#identity-login-password", password);
  await page.clickText("Continue");
  await page.poll("!!document.querySelector('#identity-login-code')");
  await clock.loginCode(bundle.secret, [correct], async code => {
    await page.fill("#identity-login-code", code);
    await page.clickText("Sign in");
    await page.poll("!location.pathname.includes('/_/login')");
    const after = await accountStatus();
    assertEquals([after.status, after.body.login, after.body.totpEnabled, after.body.credentialRevision], [200, login, true, opened.body.credentialRevision + 1]);
    const read = await page.evaluate("fetch('/_/api/notes/Desktop%20proof').then(async r=>[r.status,(await r.json()).content])");
    assertEquals(read, [200, seed], "Fresh authenticator sign-in opens the real note");
  });
  assertEquals(page.pageErrors, []);
  console.log(`Setup and Account desktop authenticator checks complete: ${artifacts}`);
});
