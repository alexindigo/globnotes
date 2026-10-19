// Real-clipboard observation through page JS APIs that work on plain HTTP
// (addendum-js-clipboard). The application page itself is never focused, typed
// into or read from. A test-owned witness page — served here on the local test
// domain, never by globnotes — reads with the trusted `paste` event of a native
// Ctrl+V and writes with execCommand("copy") plus a `copy` handler. Its
// activation is a CDP user gesture, so the application keeps page focus.
// Clipboard snapshots remain guest-process memory only, never logs/artifacts.
import { nativeSession } from "./native-cdp-session.mjs";
import { assertHttpTestUrl, bindAddress, httpOrigin } from "./http-origin.mjs";

const WITNESS = `<!doctype html><meta charset="utf-8"><title>clipboard witness</title>
<textarea id="sink"></textarea><button id="write">Write</button>
<script>
window.__pastes = []; window.__items = null; window.__written = null;
document.getElementById("sink").addEventListener("paste", event => {
  event.preventDefault();
  const data = event.clipboardData;
  window.__pastes.push({ trusted: event.isTrusted, items: [...data.types].filter(type => type !== "Files").sort().map(type => ({ type, data: data.getData(type) })) });
});
document.addEventListener("copy", event => {
  if (!window.__items) return;
  for (const { type, data } of window.__items) event.clipboardData.setData(type, data);
  event.preventDefault();
}, { capture: true });
document.getElementById("write").addEventListener("click", () => { window.__written = document.execCommand("copy"); });
window.__ready = true;
</script>`;

const witnesses = new Map();

/** Opens the page's witness (idempotent). Call before focus-sensitive steps:
 * creating the witness target can move browser focus away from the app. */
export function prepareClipboardWitness(page) {
  let witness = witnesses.get(page.browserContextId);
  if (!witness) {
    witness = openWitness(new URL(page.version.webSocketDebuggerUrl).port);
    witnesses.set(page.browserContextId, witness);
  }
  return witness;
}

async function openWitness(port) {
  const server = Deno.serve({ hostname: bindAddress(), port: 0, onListen() {} }, () =>
    new Response(WITNESS, { headers: { "content-type": "text/html; charset=utf-8" } }));
  let session;
  try {
    session = await nativeSession({ port: Number(port) });
    const url = assertHttpTestUrl(httpOrigin(server.addr.port) + "/");
    await session.send("Page.navigate", { url: url.href });
    await session.poll(`location.origin === ${JSON.stringify(url.origin)} && window.__ready === true`);
    if (await session.evaluate("isSecureContext") !== false) throw Error("Clipboard witness unexpectedly has a secure context");
  } catch (error) {
    await session?.close().catch(() => {});
    await server.shutdown();
    throw error;
  }
  return { session, server };
}

/** Closes the page's witness, if one was opened. */
export async function closeClipboardWitness(page) {
  const pending = witnesses.get(page.browserContextId);
  if (!pending) return;
  witnesses.delete(page.browserContextId);
  const { session, server } = await pending;
  try { await session.close(); } finally { await server.shutdown(); }
}

/** Every type the browser exposes to pages, as [{ type, data }] sorted by type. */
export async function captureClipboard(page) {
  const { session } = await prepareClipboardWitness(page);
  const before = await session.evaluate("window.__pastes.length");
  await session.evaluate("document.getElementById('sink').focus(), true");
  const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 };
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await session.poll(`window.__pastes.length > ${before}`, { timeout: 5000 });
  const paste = await session.evaluate(`window.__pastes[${before}]`);
  if (!paste.trusted) throw Error("Clipboard witness paste was not a trusted browser paste");
  return paste.items;
}

export async function writeClipboard(page, items) {
  const { session } = await prepareClipboardWitness(page);
  await session.evaluate(`window.__items = ${JSON.stringify(items)}; window.__written = null; true`);
  try {
    await session.send("Runtime.evaluate", { expression: "document.getElementById('write').click()", userGesture: true });
    await session.poll("window.__written !== null", { timeout: 5000 });
    if (await session.evaluate("window.__written") !== true) throw Error("Clipboard witness write was refused");
  } finally { await session.evaluate("window.__items = null; true"); }
}

export const readClipboardText = async page => (await captureClipboard(page)).find(item => item.type === "text/plain")?.data ?? "";
export const writeClipboardText = (page, text) => writeClipboard(page, [{ type: "text/plain", data: text }]);

/** Page JS cannot clear the system clipboard: empty offers are equivalent to
 * an empty prior snapshot. Non-empty snapshots retain exact type/order/data. */
export function clipboardRestored(snapshot, captured) {
  return snapshot.length === 0
    ? captured.every(item => item.data === "")
    : JSON.stringify(captured) === JSON.stringify(snapshot);
}

export async function restoreClipboard(page, snapshot, { write = writeClipboard, capture = captureClipboard } = {}) {
  // An empty copy payload leaves old data intact; explicitly replace it.
  await write(page, snapshot.length ? snapshot : [{ type: "text/plain", data: "" }]);
  if (!clipboardRestored(snapshot, await capture(page))) throw Error("Prior clipboard was not restored");
}
