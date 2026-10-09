// Compatibility actions over the project's existing owned native-CDP sessions.
// Browser process/profile stays intact; this caller owns only its fresh targets.
import { nativeSession } from "./native-cdp-session.mjs";
import { clickReady } from "./native-actions.mjs";
const bindings = new WeakMap();

export async function launchBrowser({ port = 9335 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Owned native browser is unavailable");
  const binding = { port };
  bindings.set(binding, new Set());
  return binding;
}
export async function stopBrowser(binding) {
  const owned = bindings.get(binding);
  if (!owned) throw new Error("Unknown browser binding");
  await Promise.all([...owned].map(page => page.close()));
  bindings.delete(binding);
}
export async function connect({ binding, port = binding?.port ?? 9335 } = {}) {
  const owned = binding ? bindings.get(binding) : new Set();
  if (!owned || binding && binding.port !== port) throw new Error("Unknown or mismatched browser binding");
  const session = await nativeSession({ port });
  let closing;
  const page = {
    ...session,
    pageErrors: session.errors,
    click: selector => clickReady(session, selector),
    onEvent: session.page.onEvent,
    addInitScript: source => session.send("Page.addScriptToEvaluateOnNewDocument", { source }),
    async reload() { await session.send("Page.reload"); await session.poll("document.readyState==='complete'"); },
    async clickText(text) {
      await session.poll(`(()=>{document.querySelector('[data-cdp-click-target]')?.removeAttribute('data-cdp-click-target');const root=document.querySelector('[data-modal-top="true"]')??document.body;const elements=[...root.querySelectorAll('button,a[href],[role=button],label')].filter(el=>el.getBoundingClientRect().width&&!el.disabled);const exact=elements.find(el=>el.textContent.trim()===${JSON.stringify(text)});const containing=elements.filter(el=>el.textContent.includes(${JSON.stringify(text)})).sort((a,b)=>a.textContent.length-b.textContent.length);const el=exact??containing[0];el?.setAttribute('data-cdp-click-target','1');return !!el;})()`);
      await clickReady(session, '[data-cdp-click-target]');
    },
    fill: (selector, value) => session.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing input');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`),
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    async grantClipboard(origin) { await session.browser.send("Browser.grantPermissions", { origin, browserContextId: session.browserContextId, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }); },
    readClipboard: () => session.evaluate("navigator.clipboard.readText()"),
    async screenshot(path) { const { data } = await session.send("Page.captureScreenshot", { format: "png" }); await Deno.writeFile(path, Uint8Array.from(atob(data), character => character.charCodeAt(0)), { createNew: true }); },
    close() { return closing ??= session.close().finally(() => owned.delete(page)); },
  };
  owned.add(page);
  return page;
}
