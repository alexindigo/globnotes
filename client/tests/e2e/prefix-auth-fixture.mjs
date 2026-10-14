// Feature-owned production cwd: prefix stamping never changes donor assets.
const ROOT = new URL("../../..", import.meta.url).pathname;
const assert = (value, message) => { if (!value) throw Error(message); };
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");

async function copyAssets(source, destination, rows, relative = "") {
  await Deno.mkdir(destination, { mode: 0o700 });
  for await (const entry of Deno.readDir(source)) {
    assert(!entry.isSymlink, "Production fixture cannot follow an asset symlink");
    const from = `${source}/${entry.name}`, to = `${destination}/${entry.name}`;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory) await copyAssets(from, to, rows, name);
    else if (entry.isFile) {
      const bytes = await Deno.readFile(from);
      await Deno.writeFile(to, bytes, { createNew: true });
      const sha256 = await hash(bytes);
      assert(await hash(await Deno.readFile(to)) === sha256, "Production asset copy mismatch");
      rows.push({ path: name, sha256 });
    }
  }
}

export async function bootPrefixAuthFixture({ directory, vault, state, prefix, setup, headers }) {
  const cwd = `${directory}/production-cwd`;
  await Deno.mkdir(cwd, { mode: 0o700 });
  await Deno.mkdir(`${cwd}/client`);
  const assets = [];
  await copyAssets(`${ROOT}/client/dist`, `${cwd}/client/dist`, assets);
  assets.sort((a, b) => a.path.localeCompare(b.path));
  await Deno.writeTextFile(`${directory}/production-assets-before.json`, JSON.stringify({ sourceRoot: ROOT, cwd, assets }, null, 2), { createNew: true });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port; listener.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--cached-only", "--frozen", `--config=${ROOT}/deno.json`, "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", `${ROOT}/server/main.ts`],
    cwd, clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "", NO_COLOR: "1", GLOBNOTES_PATH: vault, GLOBNOTES_INDEX_PATH: state, GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_PATH_PREFIX: prefix, GLOBNOTES_AUTO_ENABLE_PLUGINS: "false", GLOBNOTES_HOST: "127.0.0.1", GLOBNOTES_PORT: String(port) },
    stdout: "piped", stderr: "piped",
  }).spawn();
  const baseUrl = `http://127.0.0.1:${port}`, logs = { stdout: "", stderr: "" };
  await Deno.writeTextFile(`${directory}/startup-ownership.json`, JSON.stringify({ pid: child.pid, vault, state, prefix, port, cwd, sourceRoot: ROOT }), { createNew: true });
  const drains = ["stdout", "stderr"].map(async name => {
    const file = await Deno.open(`${directory}/server-${name}.log`, { write: true, createNew: true });
    try {
      for await (const chunk of child[name]) {
        logs[name] += new TextDecoder().decode(chunk);
        let offset = 0; while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
      }
    } finally { file.close(); }
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { child.kill("SIGTERM"); } catch { /* exact owned child already exited */ }
    let timer;
    const status = await Promise.race([child.status, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
    clearTimeout(timer);
    if (!status) { try { child.kill("SIGKILL"); } catch { /* already exited */ } await child.status; }
    await Promise.all(drains);
    for (const row of assets) assert(await hash(await Deno.readFile(`${ROOT}/client/dist/${row.path}`)) === row.sha256, "Donor production assets changed during prefix fixture");
  }
  const deadline = Date.now() + 30000;
  try {
    for (;;) {
      let ready = false;
      try {
        const response = await fetch(`${baseUrl}${prefix}/_/api/health`, { signal: AbortSignal.timeout(5000) });
        ready = response.ok; await response.body?.cancel();
      } catch { /* bounded startup only */ }
      if (ready) break;
      assert(Date.now() < deadline, "Prefix fixture health startup deadline");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (;;) {
      const response = await fetch(`${baseUrl}${prefix}/_/api/plugin-host`, { headers, signal: AbortSignal.timeout(5000) });
      const catalog = await response.json();
      if (setup) { assert(response.status === 503, "Setup catalogue did not reject before runtime"); break; }
      assert(response.ok, `Prefix catalogue rejected: ${response.status}`);
      const plugin = catalog.plugins.find(plugin => plugin.id === "gps08");
      assert(plugin?.status !== "failed", "Prefix fixture Worker failed rather than becoming ready");
      if (plugin?.status === "ready" && plugin.commands.some(command => command.id === "consume")) break;
      assert(Date.now() < deadline, "Prefix fixture actual command readiness deadline");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) { await close(); throw error; }
  return { baseUrl, pid: child.pid, logs, close, cwd, assets };
}
