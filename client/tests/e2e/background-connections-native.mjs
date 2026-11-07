// Server-side stream witness, real background tab, missed-change catch-up and
// the existing Autosave timer plugin's actual save after reactivation.
import { runCase } from "./legacy-fixture.mjs";
import { bindAddress, httpOrigin } from "./http-origin.mjs";
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { assert } from "./test-outcomes.mjs";

const paths = ["/_/api/changes", "/_/api/plugin-host/events"];
const until = (predicate, label) => waitUntil(async () => await predicate() ? done() : pending({ label }), { label, intervalMs: 50 });
await runCase("background-connections-native", async f => {
  const live = new Map(paths.map(path => [path, 0])), admitted = new Map(paths.map(path => [path, 0])), history = [];
  const shutdown = new AbortController(), controllers = new Set();
  let background;
  const proxy = Deno.serve({ hostname: bindAddress(), port: 0, onListen() {}, signal: shutdown.signal }, async (request, info) => {
    const url = new URL(request.url), path = url.pathname;
    const controller = new AbortController(); controllers.add(controller);
    const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
    let counted = false;
    const retire = () => {
      if (counted) { counted = false; live.set(path, live.get(path) - 1); history.push({ path, action: "close", at: Date.now() }); }
      controllers.delete(controller); controller.abort();
    };
    info.completed.catch(retire);
    try {
      const response = await fetch(f.baseUrl + path + url.search, { method: request.method, headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        signal: AbortSignal.any([shutdown.signal, controller.signal]), redirect: "manual" });
      if (!paths.includes(path) || !response.ok) { controllers.delete(controller); return response; }
      counted = true; live.set(path, live.get(path) + 1); admitted.set(path, admitted.get(path) + 1);
      history.push({ path, action: "open", at: Date.now() });
      const reader = response.body.getReader();
      return new Response(new ReadableStream({
        async pull(destination) {
          try { const { done, value } = await reader.read(); if (done) { retire(); destination.close(); } else destination.enqueue(value); }
          catch (error) { retire(); destination.error(error); }
        },
        async cancel() { retire(); await reader.cancel().catch(() => {}); },
      }), { status: response.status, headers: response.headers });
    } catch { retire(); return new Response("Owned stream witness unavailable", { status: 502 }); }
  });
  try {
    const base = httpOrigin(proxy.addr.port);
    await f.page.goto(base + "/readme");
    await f.page.poll("!!document.querySelector('.toast-viewer')");
    await until(() => paths.every(path => live.get(path) === 1), "both foreground streams admitted");
    ({ targetId: background } = await f.session.browser.send("Target.createTarget", { url: "about:blank", browserContextId: f.session.browserContextId }));
    await f.session.browser.send("Target.activateTarget", { targetId: background });
    await f.page.poll("document.visibilityState==='hidden'");
    const hiddenAt = Date.now();
    await until(() => paths.every(path => live.get(path) === 0), "hidden page releases both server streams");
    assert(Date.now() - hiddenAt >= 9000, "Hidden grace was skipped");
    const hiddenAdmissions = Object.fromEntries(admitted);
    const missed = "Changed while this tab was hidden.\n";
    await Deno.writeTextFile(f.vault + "/readme.md", missed);
    const settingsPath = "plugin-host/globnotes-autosave-timer/settings/autosave";
    const before = await f.api(settingsPath);
    assert(before.status === 200, "Autosave fixture settings missing");
    const settings = await f.api(settingsPath, "PUT", { revision: before.body.revision, sourceKey: before.body.sourceKey,
      values: { ...before.body.values, enabled: true, mode: "pause", pauseSeconds: 1 } });
    assert(settings.status === 200, "Could not enable the existing browser plugin while hidden");
    assert(paths.every(path => live.get(path) === 0), "Hidden events reopened a stream");
    await f.session.browser.send("Target.activateTarget", { targetId: f.session.targetId });
    await f.page.poll("document.visibilityState==='visible'");
    await until(() => paths.every(path => live.get(path) === 1 && admitted.get(path) > hiddenAdmissions[path]), "both streams reconnect");
    await f.page.poll("document.querySelector('.toast-viewer')?.textContent.includes('Changed while this tab was hidden.')");
    await f.page.button("Edit", ".content-column"); await f.page.button("Source", ".content-column");
    await f.page.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
    await f.page.click(".cm-content");
    await f.page.key("a", { modifiers: 2, code: "KeyA", windowsVirtualKeyCode: 65 });
    const text = "# Background recovered\n\nAutosaved after return.\n";
    await f.page.type(text);
    await until(async () => await Deno.readTextFile(f.vault + "/readme.md") === text, "reactivated browser contribution autosaves to disk");
    const result = { live: Object.fromEntries(live), hiddenAdmissions, admitted: Object.fromEntries(admitted), history,
      missedChangeRendered: true, pluginAutosaved: await Deno.readTextFile(f.vault + "/readme.md"),
      secure: await f.page.evaluate("isSecureContext"), origin: await f.page.evaluate("location.origin") };
    await Deno.writeTextFile(f.directory + "/streams.json", JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (background) await f.session.browser.send("Target.closeTarget", { targetId: background });
    for (const controller of controllers) controller.abort();
    shutdown.abort(); await proxy.finished;
  }
});
