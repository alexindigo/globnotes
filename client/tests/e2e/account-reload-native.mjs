import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";
import { spawnOwnedChild } from "../../../tests/helpers/owned_child.ts";
import { fixtureScope } from "./fixture-ownership.mjs";
import { httpOrigin, testOrigin } from "./http-origin.mjs";
import { nativeSession } from "./native-cdp-session.mjs";
import { assert } from "./test-outcomes.mjs";

await fixtureScope(async scope => {
  const { host, address } = testOrigin();
  let drain = Promise.resolve();
  scope.defer(() => drain);
  const site = (await spawnOwnedChild(scope, Deno.execPath(), {
    args: ["run", "-A", "--cached-only", "--frozen", "node_modules/vite/bin/vite.js", "--host", address, "--port", "0", "--strictPort"],
    env: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host, NO_COLOR: "1" }, stdout: "piped", stderr: "piped",
  })).value;
  const logs = { stdout: "", stderr: "" };
  drain = Promise.all(["stdout", "stderr"].map(async name => {
    for await (const text of site[name].pipeThrough(new TextDecoderStream())) logs[name] += text;
  }));
  const port = await waitUntil(() => {
    const [, number] = logs.stdout.match(/https?:\/\/[^:\s]+:(\d+)\//) ?? [];
    return number && Number(number) > 0 ? done(Number(number)) : pending(logs);
  }, { label: "prepared app fixture URL", children: [{ status: site.status, logs: () => logs }] });
  const page = await scope.acquire(() => nativeSession({ port: Number(Deno.env.get("CDP_PORT") ?? 9335) }), value => value.close());
  const browser = page.value, url = httpOrigin(port) + "/_/tests/e2e/fixtures/account-reload.html";
  await browser.goto(url);
  await browser.poll("document.querySelector('[data-active-account]')?.textContent === 'alice'");
  await browser.evaluate("window.beforeAccountReload = performance.timeOrigin");
  await browser.button("Switch account");
  const notice = await browser.read("[role=alert] [data-sticky-toast] button", `(() => {
    const toast = document.querySelector('[role=alert] [data-sticky-toast]').closest('[role=alert]');
    return { detail: toast.querySelector('p').textContent, buttons: [...toast.querySelectorAll('button')].map(b => b.textContent.trim()),
      unchanged: window.beforeAccountReload === performance.timeOrigin && document.querySelector('[data-active-account]').textContent === 'alice', secure: isSecureContext };
  })()`);
  assert(JSON.stringify(notice) === JSON.stringify({ detail: "You're now signed in as bob. Reload to continue.", buttons: ["Reload"], unchanged: true, secure: false }), `Incorrect account reload notice: ${JSON.stringify(notice)}`);
  await browser.key("Tab", { code: "Tab", windowsVirtualKeyCode: 9 });
  await browser.poll("document.activeElement?.matches('[data-sticky-toast] button:focus-visible')");
  await browser.button("Reload", "[data-sticky-toast]");
  await waitUntil(async () => {
    const view = await browser.evaluate("({ account: document.querySelector('[data-active-account]')?.textContent, oldDocument: window.beforeAccountReload !== undefined, href: location.href })");
    return view.account === "bob" && !view.oldDocument ? done() : pending(view);
  }, { label: "replacement account after the Reload action" });
  assert(await browser.evaluate("performance.getEntriesByType('navigation')[0]?.type === 'reload' && !document.querySelector('[data-sticky-toast]')"), "Reload did not start a clean document for the replacement account");
  assert(browser.errors.length === 0, `Browser exceptions: ${JSON.stringify(browser.errors)}`);
});
