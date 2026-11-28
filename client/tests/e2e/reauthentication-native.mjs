// Revoke an actual session through the server's Account API. Native login reuses
// the form, preserves the mounted editor and retries the original base to disk.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { nativeAccountScenario, nativeFixtureInput } from "./config-fixture.mjs";
import { applicationServer } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { assert } from "./test-outcomes.mjs";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { identityTokenScope } from "../../../shared/identity_token.ts";
import { identityOwnerKey } from "../../../shared/identity_session.ts";

const parent = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "reauthentication-native-" });
const directory = parent + "/reauthentication-native", vault = directory + "/vault", state = directory + "/state/globnotes";
await Deno.mkdir(vault, { recursive: true }); await Deno.mkdir(state, { recursive: true });
const base = "first\n\nmiddle\n\nlast\n", username = "reauth-fixture";
const nameField = "#identity-login-name", passwordField = "#identity-login-password";
const storageRead = key => `sessionStorage.getItem(${JSON.stringify(key)})`;
const tokenRead = storageRead(identityTokenScope("").key);
let password = "initial-fixture-password", server, session;
const writes = [], results = [], signIns = [];
await Deno.writeTextFile(vault + "/AuthNote.md", base);
const scenario = nativeAccountScenario({ account: { login: username, password } });
const fixtureInput = await nativeFixtureInput(scenario);
const until = (predicate, label) => waitUntil(async () => await predicate() ? done() : pending({ label }), { label, intervalMs: 50 });
async function fill(selector, value) {
  await session.click(selector);
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 });
  await session.type(value);
  await session.poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`);
}
async function login(secret = password) { await fill(nameField, username); await fill(passwordField, secret); await session.button("Continue"); }
async function api(path, method = "GET", body, token) {
  token ??= await session.evaluate(tokenRead);
  const response = await fetch(server.baseUrl + "/_/api/" + path, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
async function revoke() {
  const token = await session.evaluate(tokenRead);
  const before = await api("account"), next = password + "-rotated";
  assert(before.status === 200, "Read current account failed");
  const changed = await api("account", "PATCH", { newPassword: next, currentPassword: password,
    revision: before.body.credentialRevision, updateId: crypto.randomUUID() });
  assert(changed.status === 200 && changed.body.requiresLogin, "Server did not revoke the old session");
  password = next;
  assert((await api("auth-check", "GET", undefined, token)).status === 401, "Old session still authorized after server-side revocation");
}
async function rejectAdmittedSave() {
  // The live stream can present Sign in as soon as an account is revoked.
  // Admit the actual browser Save first, then retire its wire credential.
  let held, wireError;
  const stop = session.page.onEvent(event => {
    if (event.method !== "Fetch.requestPaused") return;
    const { request, requestId } = event.params;
    if (request.method === "PATCH" && new URL(request.url).pathname === "/_/api/notes/AuthNote") held = event.params;
    else session.send("Fetch.continueRequest", { requestId }).catch(error => { wireError = error; });
  });
  try {
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/notes/AuthNote*", requestStage: "Request" }] });
    await session.button("Save", ".content-column");
    await until(() => { if (wireError) throw wireError; return !!held; }, "native Save reaches the request boundary before revocation");
    assert(held.request.method === "PATCH", "Expected the real Save PATCH");
    await revoke();
    await session.send("Fetch.continueRequest", { requestId: held.requestId });
  } finally { stop(); await session.send("Fetch.disable"); }
}
async function replace(text) {
  await session.click(".cm-content");
  await session.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 });
  await session.type(text);
  await session.poll(`document.querySelector('.cm-content')?.textContent.includes(${JSON.stringify(text.split("\n")[0])})`);
}
async function capture(name) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await Deno.writeFile(`${directory}/${name}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
  if (name === "reauthentication-dialog") {
     const clip = await session.read('[role=dialog]', "(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()");
    const crop = await session.send("Page.captureScreenshot", { format: "png", clip });
    await Deno.writeFile(`${directory}/review-dialog.png`, Uint8Array.from(atob(crop.data), c => c.charCodeAt(0)));
  }
}
try {
  server = await bootServer({ ...fixtureInput, GLOBNOTES_GLOBNOTES_PATH: vault, GLOBNOTES__METADATA_PATH: directory + "/state", GLOBNOTES__SERVER_PATHPREFIX: "" }, applicationServer());
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
  session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PATCH" && new URL(event.params.request.url).pathname.startsWith("/_/api/notes/")) writes.push({ id: event.params.requestId, body: JSON.parse(event.params.request.postData) });
    if (event.method === "Network.responseReceived") {
      const { requestId, response } = event.params;
      const write = writes.find(write => write.id === requestId); if (write) write.status = response.status;
      if (response.url === `${server.baseUrl}/_/api/token`) signIns.push(response.status);
    }
  });
  await session.goto(server.baseUrl + "/AuthNote");
  await session.poll(`!!document.querySelector('${nameField}')`); await capture("login-route");
  await login(); await session.poll("document.querySelector('.toast-viewer')?.textContent.includes('first')");
  const signedIn = await api("auth-check");
  assert(signedIn.status === 200 && signedIn.body.principal?.login === username, "Expected the named fixture account");
  const accountOwner = identityOwnerKey(signedIn.body);
  const draftRead = `JSON.parse(${storageRead(`globnotes:draft:identity:${encodeURIComponent(JSON.stringify(["", accountOwner]))}:AuthNote`)})?.value`;
  await session.button("Edit", ".content-column"); await session.button("Source", ".content-column");
  await session.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
  const mine = "mine-first\n\nmiddle\n\nlast\n";
  await replace(mine);
  await session.poll(`location.hash==='#source:L${mine.split("\n").length}'`);
  await session.evaluate("window.editorBeforeAuth=document.querySelector('.cm-content'); window.sawDeparturePrompt=false; window.promptObserver=new MutationObserver(()=>{if([...document.querySelectorAll('[data-modal-top]')].some(el=>el.textContent.includes('Save Changes')))window.sawDeparturePrompt=true;});window.promptObserver.observe(document.body,{childList:true,subtree:true});");
  const route = await session.evaluate("location.pathname+location.hash");
  await rejectAdmittedSave();
  await session.poll(`!!document.querySelector('[data-reauthentication] ${nameField}')`);
  assert(await session.evaluate("document.querySelector('.cm-content')===window.editorBeforeAuth"), "401 unmounted the editor");
  assert(await session.evaluate("location.pathname+location.hash") === route, "401 changed the note URL");
  assert(await session.evaluate(draftRead) === mine, "401 did not retain the current account's draft");
  assert(!await session.evaluate("window.sawDeparturePrompt"), "401 opened a Save/Discard prompt");
  await capture("reauthentication-dialog");
  // Compare the visible field borders. The inner password input leaves room
  // for its trailing button, which belongs inside that same border.
  const eye = `button[aria-controls="${passwordField.slice(1)}"]`;
  const geometry = await session.read(['[role=dialog]', nameField, passwordField, eye, '[data-reauthentication] button[type=submit]'], `(()=>{
    const rect=el=>el.getBoundingClientRect().toJSON(), input=document.querySelector('${passwordField}');
    return {dialog:rect(document.querySelector('[role=dialog]')),username:rect(document.querySelector('${nameField}')),
      password:rect(input.closest('.password-field')),eye:rect(document.querySelector(${JSON.stringify(eye)})),
      button:rect(document.querySelector('[data-reauthentication] button[type=submit]')),width:innerWidth,height:innerHeight};
  })()`);
  assert(geometry.dialog.x >= 0 && geometry.dialog.y >= 0 && geometry.dialog.right <= geometry.width && geometry.dialog.bottom <= geometry.height, "Sign-in dialog exceeds the viewport");
  assert(Math.abs(geometry.username.x - geometry.password.x) < 1 && Math.abs(geometry.username.width - geometry.password.width) < 1 && Math.abs(geometry.username.x - geometry.button.x) < 1 && Math.abs(geometry.username.width - geometry.button.width) < 1, "Reused sign-in controls lost their structural alignment");
  assert(Math.abs(geometry.eye.width - geometry.eye.height) < 1 && Math.abs((geometry.eye.top + geometry.eye.bottom) - (geometry.password.top + geometry.password.bottom)) < 1 && geometry.eye.right <= geometry.password.right, "Password reveal is not centered in its trailing slot");
  await Deno.writeTextFile(directory + "/dialog-geometry.json", JSON.stringify(geometry, null, 2));
  await session.poll(`document.activeElement===document.querySelector('${nameField}')`);
  // Escape/Tab ownership is the shared Modal's; tabbing stays inside this dialog.
  await session.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9 });
  assert(await session.evaluate("!!document.activeElement.closest('[data-reauthentication]')"), "Login dialog lost focus containment");
  await session.click(eye);
  await session.poll(`document.querySelector('${passwordField}').type==='text' && document.activeElement?.getAttribute('aria-label')==='Hide password'`);
  // Chromium needs the Enter character to activate a focused native button.
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await session.poll(`document.querySelector('${passwordField}').type==='password' && document.activeElement?.getAttribute('aria-label')==='Show password'`);
  await login("incorrect-fixture-password");
  await session.poll("document.body.textContent.includes('Login Failed')");
  assert(JSON.stringify(signIns) === "[200,401]" && writes.length === 1 && writes[0].status === 401, "Expected real rejected sign-in and no pending Save replay");
  assert(await session.evaluate("document.querySelector('.cm-content')===window.editorBeforeAuth && !window.sawDeparturePrompt"), "Rejected sign-in abandoned the editor or asked to discard");
  assert(await session.evaluate("location.pathname+location.hash") === route && await session.evaluate(draftRead) === mine, "Rejected sign-in lost the original URL or draft");
  const theirs = "first\n\nmiddle\n\ntheirs\n";
  await Deno.writeTextFile(vault + "/AuthNote.md", theirs);
  await login();
  await until(() => signIns.length === 3, "real recovery sign-in response");
  assert(signIns[2] === 200, `Recovery credential was not accepted: ${JSON.stringify(signIns)}`);
  const merged = "mine-first\n\nmiddle\n\ntheirs\n";
  await until(async () => await Deno.readTextFile(vault + "/AuthNote.md") === merged, "automatic base-aware save reaches disk after sign-in");
  await session.poll("!document.querySelector('[data-reauthentication]') && [...document.querySelectorAll('[data-pc-name=toast] [data-pc-section=detail]')].some(el=>el.textContent==='Merged with changes made elsewhere')");
  await session.poll("document.querySelector('.cm-content')?.textContent.includes('theirs')");
  assert(writes.length === 2 && writes[0].status === 401 && writes[1].status === 200, "Expected rejected original and one automatic retry");
  assert(JSON.stringify(writes[0].body) === JSON.stringify(writes[1].body) && writes[1].body.baseContent === base, "Authentication retry changed its submitted text or original base");
  assert(await session.evaluate("document.querySelector('.cm-content')===window.editorBeforeAuth && !window.sawDeparturePrompt"), "Sign-in abandoned the editor or asked to discard");
  await capture("saved-after-reauthentication");
  results.push({ case: "automatic-merge", disk: merged, originalBasePreserved: true, sameEditor: true, departurePrompt: false });

  const cancelled = "cancelled-sign-in edits stay unsaved\n";
  await replace(cancelled); await rejectAdmittedSave();
  await session.poll("!!document.querySelector('[data-reauthentication]')");
  await session.button("Cancel", "[data-reauthentication]");
  await session.poll("!document.querySelector('[data-reauthentication]') && document.querySelector('[data-note-save-status]')?.textContent.includes('Not saved')");
   assert(await session.evaluate("document.querySelector('.cm-content')===window.editorBeforeAuth && document.querySelector('.cm-content')?.textContent.includes('cancelled-sign-in edits stay unsaved')"), "Cancelling login lost the edits");
  assert(await session.evaluate(draftRead) === cancelled, "Cancelling login lost the account's persisted draft");
  assert(await Deno.readTextFile(vault + "/AuthNote.md") === merged && writes.length === 3, "Cancelling sign-in sent a save or changed disk");
  assert(!await session.evaluate("window.sawDeparturePrompt"), "Cancel path opened Save/Discard");
  await capture("cancelled-unsaved");
   results.push({ case: "cancel", diskUnchanged: true, sameEditor: true, draft: cancelled, status: await session.read('[data-note-save-status]', "document.querySelector('[data-note-save-status]').textContent") });

  const newer = "newer edits queued for sign-in\n";
  await replace(newer); await session.button("Save", ".content-column");
  await session.poll("!!document.querySelector('[data-reauthentication]')");
  assert(!await session.evaluate("document.body.textContent.includes('Save held')"), "Authentication recovery showed the non-recovering Save held error");
  await login();
  await until(async () => await Deno.readTextFile(vault + "/AuthNote.md") === newer, "newer auth-held snapshot follows its original job to disk");
  await session.poll("document.querySelector('[data-note-save-status]')?.textContent===''");
  assert(writes.length === 5 && writes[3].status === 200 && writes[4].status === 200, "Expected original pending save followed by newer snapshot");
  assert(writes[3].body.newContent === cancelled && writes[3].body.baseContent === merged && writes[4].body.newContent === newer && writes[4].body.baseContent === cancelled, "Recovery changed the FIFO snapshots or bases");
  assert(!await session.evaluate("document.body.textContent.includes('Save held')"), "A recovering held submission emitted an error toast");
  results.push({ case: "newer-auth-held-save", disk: newer, heldError: false, fifoBasesPreserved: true });

  // Model a proxy's bodyless 401 during the read-only rename preparation,
  // with a genuinely revoked server session. The retry uses the real endpoint.
  let previewRequest;
  const releasePreview = session.page.onEvent(event => {
    if (event.method === "Fetch.requestPaused") previewRequest = event.params.requestId;
  });
  try {
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/rename-preview*", requestStage: "Request" }] });
    await fill('input[placeholder="Folder (root)"]', "Renamed");
    await session.key("Enter", { code: "Enter", windowsVirtualKeyCode: 13 });
    await until(() => !!previewRequest, "rename preparation request intercepted");
    await revoke();
    await session.send("Fetch.fulfillRequest", { requestId: previewRequest, responseCode: 401 });
    await session.send("Fetch.disable");
    await session.poll("!!document.querySelector('[data-reauthentication]') && document.querySelector('[data-note-save-status]')?.textContent.includes('Not saved')");
    assert(writes.length === 5, "An unauthorized preview dispatched a write");
    await login();
    await until(async () => {
      try { return await Deno.readTextFile(vault + "/Renamed/AuthNote.md") === newer; }
      catch (error) { if (error instanceof Deno.errors.NotFound) return false; throw error; }
    }, "bare preview 401 retries the original rename after sign-in");
  await session.poll("location.pathname==='/Renamed/AuthNote' && document.querySelector('[data-note-save-status]')?.textContent===''");
    assert(writes.length === 6 && writes[5].status === 200 && writes[5].body.newPath === "Renamed/AuthNote" && writes[5].body.baseContent === newer, "Rename recovery changed its original target or base");
    assert(await Deno.stat(vault + "/AuthNote.md").then(() => false, error => error instanceof Deno.errors.NotFound), "Successful rename retained the old file");
    assert(await session.evaluate("document.querySelector('.cm-content')===window.editorBeforeAuth && !window.sawDeparturePrompt"), "Preview recovery abandoned the editor or opened Save/Discard");
    results.push({ case: "bare-preview-401", disk: "Renamed/AuthNote.md", automaticRetry: true, basePreserved: true, sameEditor: true });
  } finally { releasePreview(); await session.send("Fetch.disable"); }
  assert(session.errors.length === 0, `Browser exceptions: ${JSON.stringify(session.errors)}`);
  await Deno.writeTextFile(directory + "/results.json", JSON.stringify({ results, writes, signIns, events: session.events }, null, 2));
} catch (error) {
  if (session) {
    await capture("failure").catch(() => {});
    const observed = await session.evaluate(`({href:location.href,text:document.body.innerText,editor:document.querySelector('.cm-content')?.textContent,sameEditor:document.querySelector('.cm-content')===window.editorBeforeAuth,departurePrompt:window.sawDeparturePrompt,tokenPresent:!!${tokenRead}})`).catch(() => null);
    await Deno.writeTextFile(directory + "/failure.json", JSON.stringify({ error: String(error), observed, results, writes, signIns, events: session.events, errors: session.errors }, null, 2));
  }
  throw error;
} finally { await session?.close(); await server?.close(); }
