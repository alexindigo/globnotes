// M4 consumer proof (stale delete, O4): the browser deletes with the version
// it loaded; a change made elsewhere while the delete is in flight wins, the
// note stays and shows the current text; a delete from the current version
// then succeeds. Plain HTTP on the test domain, real filesystem writes.
import { bootServer } from "../../../tests/helpers/boot.ts";
import { applicationServer } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";

const assert = (condition, message) => { if (!condition) throw Error(message); };
const parent = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "m4-native-" });
const directory = `${parent}/hub-writers-gate-native`;
await Deno.mkdir(directory, { recursive: true });
const vault = `${directory}/vault`;
await Deno.mkdir(vault, { recursive: true });
let server, session;
const results = [], deletes = [];
async function shellWrite(path, text) {
  const result = await new Deno.Command("bash", {
    args: ["-c", "printf '%s' \"$2\" > \"$1\"", "m4-shell-write", `${vault}/${path}.md`, text],
    stdout: "piped", stderr: "piped",
  }).output();
  assert(result.success, `External shell write failed: ${new TextDecoder().decode(result.stderr)}`);
}
async function capture(name) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await Deno.writeFile(`${directory}/${name}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
}
async function confirmDelete() {
  await session.button("Delete", ".content-column");
  await session.poll("document.body.textContent.includes('Confirm Deletion')");
  await session.button("Delete", '[data-modal-top="true"]');
}
try {
  await shellWrite("Doomed", "loaded text\n");
  server = await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault, GLOBNOTES_METADATA_PATH: `${directory}/state`,
    fixtureAuth: { auth_type: "none" }, GLOBNOTES__SERVER_PATHPREFIX: "" }, applicationServer());
  session = await nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) });
  let held = null;
  session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "DELETE") deletes.push(event.params.request.url);
    if (event.method === "Fetch.requestPaused") held = event.params.requestId;
  });
  await session.goto(`${server.baseUrl}/Doomed`);
  await session.poll("document.querySelector('.toast-viewer')?.textContent.includes('loaded text')");
  const origin = await session.evaluate("location.origin"), secure = await session.evaluate("isSecureContext");
  assert(secure === false, "the application page must not be a secure context");
  const loaded = await session.evaluate("fetch('/_/api/notes/Doomed').then(r=>r.json()).then(n=>n.version)");

  // Hold the DELETE request, change the note outside, then let it go.
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*/_/api/notes/Doomed?*", requestStage: "Request" }] });
  await confirmDelete();
  for (let i = 0; i < 200 && !held; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(held, "the delete request was not intercepted");
  await shellWrite("Doomed", "changed elsewhere\n");
  await session.send("Fetch.continueRequest", { requestId: held });
  await session.send("Fetch.disable", {});
  await session.poll("document.body.textContent.includes('Changed elsewhere')");
  await session.poll("document.querySelector('.toast-viewer')?.textContent.includes('changed elsewhere')");
  await capture("stale-delete-refused");
  assert(new URL(deletes.at(-1)).searchParams.get("base_version") === loaded, "the delete did not send the loaded version");
  assert(await Deno.readTextFile(`${vault}/Doomed.md`) === "changed elsewhere\n", "the stale delete removed or changed the note");
  assert(await session.evaluate("decodeURIComponent(location.pathname)") === "/Doomed", "the stale delete navigated away");
  results.push({ case: "stale-delete-refused", origin, secure, loaded, kept: "changed elsewhere\n" });

  // Deleting from the version now shown succeeds.
  await confirmDelete();
  await session.poll("location.pathname === '/'");
  const gone = await Deno.stat(`${vault}/Doomed.md`).then(() => false, error => error instanceof Deno.errors.NotFound);
  assert(gone, "a delete from the current version did not delete the note");
  await capture("current-delete");
  results.push({ case: "current-delete", deleted: true, deleteUrls: deletes.length });

  assert(session.errors.length === 0, `Browser exceptions: ${JSON.stringify(session.errors)}`);
  await Deno.writeTextFile(`${directory}/results.json`, JSON.stringify({ results, deletes, events: session.events }, null, 2));
  console.log(JSON.stringify({ cases: results, artifacts: directory }));
} catch (error) {
  if (session) {
    await capture("failure").catch(() => {});
    const observation = await session.evaluate("({href:location.href,text:document.body.textContent.slice(0,2000)})").catch(() => null);
    await Deno.writeTextFile(`${directory}/failure.json`, JSON.stringify({ error: error.message, observation, results, deletes }, null, 2));
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
