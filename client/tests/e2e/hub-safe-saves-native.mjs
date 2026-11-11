// M2 consumer proof: actual filesystem writes, normal HTTP, real editor ports.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { applicationServer } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";

const assert = (condition, message) => { if (!condition) throw Error(message); };
// Under the native suite the artifacts directory is shared; keep this case's
// vault, screenshots and results in its own subdirectory (as runCase does).
const parent = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "m2-native-" });
const directory = `${parent}/hub-safe-saves-native`;
await Deno.mkdir(directory, { recursive: true });
const vault = `${directory}/vault`;
await Deno.mkdir(vault, { recursive: true });
let server, session;
const results = [], writes = [];
const base = "first\n\nmiddle\n\nlast\n";
async function shellWrite(path, text) {
  const result = await new Deno.Command("bash", {
    args: ["-c", "printf '%s' \"$2\" > \"$1\"", "m2-shell-write", `${vault}/${path}.md`, text],
    stdout: "piped", stderr: "piped",
  }).output();
  assert(result.success, `External shell write failed: ${new TextDecoder().decode(result.stderr)}`);
}
async function capture(name) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await Deno.writeFile(`${directory}/${name}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
}
async function saved() {
  await session.poll("[...document.querySelectorAll('.content-column button')].find(b=>b.textContent.trim()==='Save')?.getAttribute('aria-busy')==='false'");
}
async function focusFirst(mode) {
  const selector = mode === "WYSIWYG" ? ".ProseMirror > p" : ".cm-content";
  await session.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
  await session.click(selector);
  await session.key("Home", { code: "Home", modifiers: mode === "WYSIWYG" ? 0 : 2, windowsVirtualKeyCode: 36 });
  const firstLine = mode === "WYSIWYG" ? ".ProseMirror > p" : ".cm-content > .cm-line";
  await session.poll(`(() => { const selection=getSelection(), line=document.querySelector(${JSON.stringify(firstLine)}); return !!selection?.anchorNode && line?.contains(selection.anchorNode) && selection.anchorOffset===0; })()`);
}
async function prefixFirst(mode, text) {
  await focusFirst(mode);
  await session.type(text);
  await session.poll(`document.querySelector('.cm-content, .ProseMirror')?.textContent.includes(${JSON.stringify(text + "first")})`);
}
try {
  await shellWrite("Viewing", "initial viewing text\n");
  for (const mode of ["Source", "WYSIWYG", "Preview"]) await shellWrite(`M2-${mode}`, base);
  server = await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault, GLOBNOTES_METADATA_PATH: `${directory}/state`,
    fixtureAuth: { auth_type: "none" }, GLOBNOTES__SERVER_PATHPREFIX: "" }, applicationServer());
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
  session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PATCH") {
      writes.push(JSON.parse(event.params.request.postData));
    }
  });
  await session.goto(`${server.baseUrl}/Viewing`);
  await session.poll("document.querySelector('.toast-viewer')?.textContent.includes('initial viewing text')");
  await capture("view-before");
  const began = performance.now();
  await shellWrite("Viewing", "updated by the shell\n");
  await session.poll("document.querySelector('.toast-viewer')?.textContent.includes('updated by the shell')", { timeout: 3000 });
  results.push({ case: "viewing-shell-update", elapsedMs: performance.now() - began,
    origin: await session.evaluate("location.origin"), secure: await session.evaluate("isSecureContext") });
  await capture("view-after");

  for (const mode of ["Source", "WYSIWYG", "Preview"]) {
    const path = `M2-${mode}`, inputMode = mode === "Preview" ? "Source" : mode;
    await session.goto(`${server.baseUrl}/${path}`);
    await session.poll("document.querySelector('.toast-viewer')?.textContent.includes('first')");
    await session.button("Edit", ".content-column");
    await session.button(inputMode, ".content-column");
    await prefixFirst(inputMode, "mine-");
    if (mode === "Preview") await session.button("Preview", ".content-column");
    await shellWrite(path, "first\n\nmiddle\n\ntheirs\n");
    await session.poll("document.querySelector('[data-note-save-status]')?.textContent.includes('will be merged')");
    await capture(`${mode.toLowerCase()}-dirty`);
    await session.evaluate("window.__priorMergeToasts=new Set(document.querySelectorAll('[data-pc-name=toast] [data-pc-section=detail]'));true");
    await session.button("Save", ".content-column");
    await saved();
    const selector = mode === "Preview" ? ".preview-buffer" : mode === "WYSIWYG" ? ".ProseMirror" : ".cm-content";
    await session.poll(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes('mine-first') && document.querySelector(${JSON.stringify(selector)})?.textContent.includes('theirs')`);
    assert(await Deno.readTextFile(`${vault}/${path}.md`) === "mine-first\n\nmiddle\n\ntheirs\n", `${mode}: both edits did not reach disk`);
    assert(await session.evaluate("[...document.querySelectorAll('[data-pc-name=toast] [data-pc-section=detail]')].some(el=>!window.__priorMergeToasts.has(el)&&el.textContent==='Merged with changes made elsewhere')"), `${mode}: this save's merged toast missing`);
    assert(writes.at(-1).baseContent === base, `${mode}: editor did not send its loaded base`);
    await capture(`${mode.toLowerCase()}-merged`);
    results.push({ case: "merge", mode, content: await Deno.readTextFile(`${vault}/${path}.md`) });

    if (mode === "Preview") await session.button("Source", ".content-column");
    // The new edit and the outside write now replace the same first line.
    await focusFirst(inputMode);
    await session.type("typed-");
    await session.poll("document.querySelector('.cm-content, .ProseMirror')?.textContent.includes('typed-mine-first')");
    const theirs = "outside first\n\nmiddle\n\ntheirs\n";
    await shellWrite(path, theirs);
    await session.button("Save", ".content-column"); await saved();
    await session.poll("location.pathname.includes('.conflict-') && !!document.querySelector('[data-conflict-banner]')");
    const copy = await session.evaluate("decodeURIComponent(location.pathname.slice(1))");
    assert(new RegExp(`^${path}\\.conflict-\\d{8}-\\d{6}-globnotes$`).test(copy), `${mode}: wrong copy URL ${copy}`);
    assert(await Deno.readTextFile(`${vault}/${copy}.md`) === writes.at(-1).newContent, `${mode}: copy lost submitted text`);
    assert(await Deno.readTextFile(`${vault}/${path}.md`) === theirs, `${mode}: original was overwritten`);
    assert(await session.evaluate("document.querySelector('.cm-content, .ProseMirror')?.textContent.includes('typed-mine-first')"), `${mode}: editor did not retain conflict content`);
     assert(await session.read('[data-conflict-banner]', `document.querySelector('[data-conflict-banner]').textContent.includes(${JSON.stringify(`‹${path}› changed elsewhere`)})`), `${mode}: conflict origin missing`);
    await capture(`${mode.toLowerCase()}-conflict`);
    results.push({ case: "conflict", mode, original: path, copy, copyMatchesSubmission: true, originalUnchanged: true });
  }
  assert(session.errors.length === 0, `Browser exceptions: ${JSON.stringify(session.errors)}`);
  await Deno.writeTextFile(`${directory}/results.json`, JSON.stringify({ results, writes, events: session.events }, null, 2));
  console.log(JSON.stringify({ cases: results, artifacts: directory }));
} catch (error) {
  if (session) {
    await capture("failure").catch(() => {});
    const observation = await session.evaluate("({href:location.href,active:document.activeElement?.outerHTML,editors:[...document.querySelectorAll('.cm-content,.ProseMirror')].map(el=>({text:el.textContent,html:el.outerHTML}))})").catch(() => null);
    await Deno.writeTextFile(`${directory}/failure.json`, JSON.stringify({ error: error.message, observation, results, writes }, null, 2));
    console.error(JSON.stringify(observation));
  }
  throw error;
} finally {
  if (session) {
    await Deno.writeTextFile(`${directory}/browser-errors.json`, JSON.stringify(session.errors, null, 2));
    await session.close();
  }
  await server?.close();
}
