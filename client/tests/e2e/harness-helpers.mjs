// Minimal e2e server boot helper (native, no Docker): builds are expected
// to have run (client/dist present); boots server/main.ts on a free port.
const ROOT = new URL("../../..", import.meta.url).pathname;

export async function bootServer(vault, stateDir, { env = {}, logsDir, allowFailed = false, headers = {} } = {}) {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
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
      GLOBNOTES_HOST: "127.0.0.1",
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
  const baseUrl = `http://127.0.0.1:${port}`;
  const prefix = env.GLOBNOTES_PATH_PREFIX ?? "";
  const deadline = Date.now() + 30000;
  try {
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}${prefix}/_/api/health`, { signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
      if (res.ok) break;
    } catch { /* not up */ }
    if (Date.now() > deadline) {
      throw new Error("e2e server never came up");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Wait for plugin runtime readiness through the catalog.
  const readyDeadline = Date.now() + 15000;
  for (;;) {
    const res = await fetch(`${baseUrl}${prefix}/_/api/plugin-host`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Catalog rejected: ${res.status}`); }
    const catalog = await res.json();
    if (
      catalog.plugins.every((p) =>
        !p.enabled || !p.runtime?.server || p.status === "ready" ||
        (allowFailed && p.status === "failed")
      )
    ) break;
    if (Date.now() > readyDeadline) throw new Error("plugins never ready");
    await new Promise((r) => setTimeout(r, 100));
  }
  } catch (error) { await close(); throw error; }
  return {
    baseUrl,
    close, pid: child.pid, logs,
  };
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
