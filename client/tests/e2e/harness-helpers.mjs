// Minimal e2e server boot helper (native, no Docker): builds are expected
// to have run (client/dist present); boots server/main.ts on a free port of
// the local test domain's address (http-origin.mjs).
import { bindAddress, httpOrigin } from "./http-origin.mjs";
import { done, failed, pending, waitUntil, watchChild } from "../../../tests/helpers/wait.ts";
const ROOT = new URL("../../..", import.meta.url).pathname;

export async function bootServer(vault, stateDir, { env = {}, logsDir, allowFailed = false, headers = {} } = {}) {
  const hostname = bindAddress();
  const listener = Deno.listen({ port: 0, hostname });
  const port = listener.addr.port;
  listener.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run", "--cached-only", "--frozen", `--config=${ROOT}/deno.json`,
      "--unstable-worker-options", "--allow-net", "--allow-read",
      "--allow-write", "--allow-env", `${ROOT}/server/main.ts`,
    ],
    cwd: ROOT,
    clearEnv: true,
    env: {
      ...env,
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      NO_COLOR: "1",
      GLOBNOTES_PATH: vault,
      GLOBNOTES_INDEX_PATH: stateDir,
      GLOBNOTES_AUTH_TYPE: env.GLOBNOTES_AUTH_TYPE ?? "none",
      GLOBNOTES_HOST: hostname,
      GLOBNOTES_PORT: String(port),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const logs = { stdout: "", stderr: "" };
  const drains = ["stdout", "stderr"].map(async name => {
    const file = logsDir ? await Deno.open(`${logsDir}/server-${name}.log`, { write: true, createNew: true }) : null;
    try {
      for await (const chunk of child[name]) {
        logs[name] += new TextDecoder().decode(chunk);
        if (file) {
          let offset = 0;
          while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
        }
      }
    } finally { file?.close(); }
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { child.kill("SIGTERM"); } catch { /* the owned child already exited */ }
    let timer;
    const status = await Promise.race([child.status, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
    clearTimeout(timer);
    if (!status) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await child.status;
    }
    await Promise.all(drains);
  }
  const baseUrl = httpOrigin(port);
  const prefix = env.GLOBNOTES_PATH_PREFIX ?? "";
  const children = [watchChild(child, () => logs)];
  try {
    await awaitHealthy(`${baseUrl}${prefix}`, { label: "e2e server healthy", child, logs: () => logs });
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
  } catch (error) { await close(); throw error; }
  return {
    baseUrl,
    close, pid: child.pid, logs,
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

export function parseArguments(args) {
  const result = { help: false, artifacts: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new Error(`Duplicate argument: ${option}`);
    seen.add(option);
    if (option === "--help") result.help = true;
    else if (option === "--artifacts") {
      const directory = args[++index];
      if (!directory || directory.startsWith("--")) throw new Error("--artifacts requires a directory");
      result.artifacts = directory;
    } else throw new Error(`Unknown argument: ${option}`);
  }
  return result;
}

export const writeFile = (path, content) => Deno.writeTextFile(path, content);
export const mkdir = (path, opts) => Deno.mkdir(path, opts);
export const rm = (...paths) =>
  Promise.all(paths.map((p) => Deno.remove(p, { recursive: true })));
