// Minimal e2e server boot helper (native, no Docker): builds are expected
// to have run (client/dist present); boots server/main.ts on a free port of
// the local test domain's address (http-origin.mjs).
import { bindAddress, httpOrigin } from "./http-origin.mjs";
import { done, failed, pending, waitUntil, watchChild } from "../../../tests/helpers/wait.ts";
import { bootServer as launchServer } from "../../../tests/helpers/boot.ts";
import { metadataBase } from "./config-fixture.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const configFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../../deno.json");

export async function bootServer(vault, stateDir, { env = {}, logsDir, allowFailed = false, headers = {} } = {}) {
  const hostname = bindAddress();
  // Reuse the owner of port-0 binding, private build/cwd and clean child env.
  const server = await launchServer({
      ...env,
       GLOBNOTES_GLOBNOTES_PATH: vault,
       GLOBNOTES__METADATA_PATH: metadataBase(vault, stateDir),
  }, { host: hostname, origin: httpOrigin, denoArgs: ["--cached-only", "--frozen", `--config=${configFile}`] });
  const logs = server.output;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await server.close(); }
    finally {
      if (logsDir) for (const name of ["stdout", "stderr"]) {
        await Deno.writeTextFile(`${logsDir}/server-${name}.log`, logs[name], { createNew: true });
      }
    }
  }
  const baseUrl = server.baseUrl;
   const prefix = env.GLOBNOTES__SERVER_PATHPREFIX ?? "";
  const children = [{ pid: server.pid, status: server.status, logs: server.logs }];
  try {
    // Wait for plugin runtime readiness through the catalog.
    await waitUntil(async signal => {
      const res = await fetch(`${baseUrl}${prefix}/_/api/plugin-host`, { headers, signal });
      if (!res.ok) return failed(`catalog rejected: ${res.status}`, { status: res.status, body: await res.text() });
      const catalog = await res.json();
      const servers = catalog.plugins.filter(p => p.enabled && p.runtime?.server);
      const failing = servers.filter(p => p.status === "failed");
      if (failing.length && !allowFailed) return failed(`plugin ${failing.map(p => `'${p.id}'`).join(", ")} failed`, servers);
      if (servers.every(p => p.status === "ready" || (allowFailed && p.status === "failed"))) return done();
      return pending(servers);
    }, { label: "e2e server plugins ready", intervalMs: 100, children });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { console.error(`e2e server cleanup after readiness failure: ${cleanupError}`); }
    throw error;
  }
  return {
    baseUrl,
    close, pid: server.pid, logs,
  };
}

/** Wait (tests/helpers/wait.ts) until `${base}/_/api/health` answers OK. An
 * exited `child` fails the wait at once with its output (`logs`). */
export function awaitHealthy(base, { label, child, logs, intervalMs = 100 }) {
  return waitUntil(async signal => {
    try {
      const response = await fetch(`${base}/_/api/health`, { signal });
      await response.body?.cancel();
      return response.ok ? done() : pending({ health: response.status });
    } catch (error) {
      if (signal.aborted) throw error;
      return pending({ health: String(error) }); // not up yet
    }
  }, { label, intervalMs, children: child ? [watchChild(child, logs)] : [] });
}

/** Wait until plugin `id` is ready in `${base}/_/api/plugin-host`; a failed
 * plugin, a rejected catalog or an exited `child` fails at once. */
export function awaitPluginReady(base, id, { label = `plugin '${id}' ready`, child, logs, headers = {}, intervalMs = 50 } = {}) {
  return waitUntil(async signal => {
    const response = await fetch(`${base}/_/api/plugin-host`, { headers, signal });
    if (!response.ok) return failed(`catalog rejected: ${response.status}`, { status: response.status, body: await response.text() });
    const plugin = (await response.json()).plugins.find(entry => entry.id === id);
    if (plugin?.status === "ready") return done(plugin);
    if (plugin?.status === "failed") return failed(`plugin '${id}' failed`, plugin);
    return pending(plugin ?? { id, status: "absent" });
  }, { label, intervalMs, children: child ? [watchChild(child, logs)] : [] });
}

export { parseArguments } from "./harness-arguments.mjs";

export const writeFile = (path, content) => Deno.writeTextFile(path, content);
export const mkdir = (path, opts) => Deno.mkdir(path, opts);
export const rm = (...paths) =>
  Promise.all(paths.map((p) => Deno.remove(p, { recursive: true })));
