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
     const response = await fetch(`${baseUrl}${prefix}/_/api/plugin-host`, { headers });
     if (!response.ok) throw Error(`catalog rejected: ${response.status}`);
     const servers = (await response.json()).plugins.filter(p => p.enabled && p.runtime?.server);
     await Promise.all(servers.map(plugin => catalogPluginReady(children[0] ? { baseUrl, ...children[0] } : { baseUrl }, plugin.id, { prefix, headers, allowFailed, label: "e2e server plugins ready" })));
  } catch (error) {
    try { await close(); }
     catch (cleanupError) { console.error(`e2e server cleanup after readiness failure: ${cleanupError}`); }
     if (error instanceof ReadinessError && error.state?.id) {
       // Keep this aggregate helper's diagnostic shape while the shared observer
       // owns each service's startup, rather than changing existing callers.
       throw new ReadinessError(error.label, error.reason, [error.state], error.elapsedMs, { cause: error });
     }
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
export function awaitPluginReady(base, id, { label = `plugin '${id}' ready`, child, logs, headers = {} } = {}) {
   return catalogPluginReady({ baseUrl: base, ...child ? watchChild(child, logs) : {} }, id, { headers, label });
}

export { parseArguments } from "./harness-arguments.mjs";

export const writeFile = (path, content) => Deno.writeTextFile(path, content);
export const mkdir = (path, opts) => Deno.mkdir(path, opts);
export const rm = (...paths) =>
  Promise.all(paths.map((p) => Deno.remove(p, { recursive: true })));
