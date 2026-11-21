// Minimal e2e server boot helper (native, no Docker): builds are expected
// to have run (client/dist present); boots server/main.ts on a free port of
// the local test domain's address (http-origin.mjs).
import { bindAddress, httpOrigin } from "./http-origin.mjs";
import { done, pending, ReadinessError, waitUntil, watchChild } from "../../../tests/helpers/wait.ts";
import { bootServer as launchServer } from "../../../tests/helpers/boot.ts";
import { metadataBase } from "./config-fixture.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { catalogPluginReady } from "../../../tests/helpers/catalog_work.ts";
import { publishRecord } from "../../../tests/helpers/process_records.ts";
import { finalizeNativeCase } from "./native-case-finalization.mjs";

const configFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../../deno.json");

export async function bootServer(vault, stateDir, { env = {}, logsDir = "", allowFailed = false, headers = {}, onServer = () => {}, denoArgs = [] } = {}) {
  const environment = { ...env }, requestHeaders = { ...headers };
  const prefix = environment.GLOBNOTES__SERVER_PATHPREFIX ?? "";
  const hostname = bindAddress();
  // Reuse the owner of port-0 binding, private build/cwd and clean child env.
  const server = await launchServer({
      ...environment,
        GLOBNOTES_GLOBNOTES_PATH: resolve(vault),
        GLOBNOTES__METADATA_PATH: metadataBase(resolve(vault), resolve(stateDir)),
  }, { host: hostname, origin: httpOrigin, denoArgs: ["--cached-only", "--frozen", `--config=${configFile}`, ...denoArgs] });
  const logs = server.output;
  let closing;
  function close() {
    return closing ??= finalizeNativeCase({ cleanup: [() => server.close(),
      ...(logsDir ? ["stdout", "stderr"].map(name => () => publishRecord(`${logsDir}/server-${name}.log`, logs[name], { createNew: true })) : []),
    ] });
  }
  const baseUrl = server.baseUrl;
  const children = [{ pid: server.pid, status: server.status, logs: server.logs }];
  const ownerGone = new AbortController();
  server.exited.then(status => ownerGone.abort(Error(`e2e server exited: ${status.code}`)));
  let readiness = [];
  try {
    onServer(server);
    // Wait for plugin runtime readiness through the catalog.
     const servers = await waitUntil(async signal => {
       const response = await fetch(`${baseUrl}${prefix}/_/api/plugin-host`, { headers: requestHeaders, signal: AbortSignal.any([signal, ownerGone.signal]) });
       if (!response.ok) throw Error(`catalog rejected: ${response.status}`);
       return done((await response.json()).plugins.filter(p => p.enabled && p.runtime?.server));
     }, { label: "e2e server plugins ready", children });
     readiness = servers.map(plugin => catalogPluginReady({ baseUrl, ...children[0], exited: server.exited }, plugin.id, { prefix, headers: requestHeaders, allowFailed, label: "e2e server plugins ready" }));
     await Promise.all(readiness);
  } catch (error) {
    try { await close(); }
     catch (cleanupError) { console.error(`e2e server cleanup after readiness failure: ${cleanupError}`); }
     await Promise.allSettled(readiness);
     if (error instanceof ReadinessError && error.state?.id) {
       // Keep this aggregate helper's diagnostic shape while the shared observer
       // owns each service's startup, rather than changing existing callers.
       throw new ReadinessError(error.label, error.reason, [error.state], error.elapsedMs, { cause: error });
     }
    throw error;
  }
  return {
    baseUrl,
    close, pid: server.pid, logs, status: server.status, exited: server.exited,
  };
}

/** Wait (tests/helpers/wait.ts) until `${base}/_/api/health` answers OK. An
 * exited `child` fails the wait at once with its output (`logs`). */
export function awaitHealthy(base, { label, child, logs, intervalMs = 100 }) {
  const ownerGone = new AbortController();
  child?.status.then(status => ownerGone.abort(Error(`health server exited: ${status.code}`)));
  return waitUntil(async signal => {
    try {
      const response = await fetch(`${base}/_/api/health`, { signal: AbortSignal.any([signal, ownerGone.signal]) });
      await response.body?.cancel();
      return response.ok ? done() : pending({ health: response.status });
    } catch (error) {
      if (signal.aborted || ownerGone.signal.aborted) throw error;
      return pending({ health: String(error) }); // not up yet
    }
  }, { label, intervalMs, children: child ? [watchChild(child, logs)] : [] });
}

/** Wait until plugin `id` is ready in `${base}/_/api/plugin-host`; a failed
 * plugin, a rejected catalog or an exited `child` fails at once. */
export function awaitPluginReady(base, id, { label = `plugin '${id}' ready`, child, logs, headers = {} } = {}) {
   return catalogPluginReady({ baseUrl: base, ...child ? { ...watchChild(child, logs), exited: child.status } : {} }, id, { headers, label });
}

/** Each artifact and each PNG destination is attempted even if another fails. */
export function captureNativeDiagnostics(session, { imagePaths, geometryPath }) {
  return finalizeNativeCase({ cleanup: [
    () => session.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))"),
    async () => {
      const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
      const bytes = Uint8Array.from(atob(screenshot.data), ch => ch.charCodeAt(0));
      await finalizeNativeCase({ cleanup: imagePaths.map(path => () => Deno.writeFile(path, bytes)) });
    },
    ...(geometryPath ? [async () => {
      const geometry = await session.evaluate("({url:location.href,focus:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('[role=dialog]')].map(el=>({title:el.getAttribute('aria-labelledby'),rect:el.getBoundingClientRect().toJSON(),inert:!!el.closest('[inert]')})),text:document.body.innerText})");
      await Deno.writeTextFile(geometryPath, JSON.stringify(geometry, null, 2), { createNew: true });
    }] : []),
  ] });
}

export { parseArguments } from "./harness-arguments.mjs";

export const writeFile = async (path, content) => await publishRecord(path, content);
export const mkdir = (path, opts) => Deno.mkdir(path, opts);
export const rm = (...paths) =>
  Promise.all(paths.map((p) => Deno.remove(p, { recursive: true })));
