// Cold-load gate: start a fresh-vault server; check health, index, assets and a note.
const [root, label] = Deno.args;
if (!root || !label) throw new Error("root and label required");
const fixture = await Deno.makeTempDir({ prefix: `v22-${label}-cold-` });
await Deno.writeTextFile(`${fixture}/ReleaseProbe.md`, "# Release Probe\n\nCached cold-load fixture.\n");
const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const port = listener.addr.port;
listener.close();
const baseUrl = `http://127.0.0.1:${port}`;
const tmpdir = Deno.env.get("TMPDIR");
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "--cached-only", "--frozen", `--config=${root}/deno.json`,
    "--unstable-worker-options", "--allow-net", "--allow-read", "--allow-write", "--allow-env", `${root}/server/main.ts`],
  cwd: root,
  clearEnv: true,
  env: { PATH: Deno.env.get("PATH"), HOME: Deno.env.get("HOME"), NO_COLOR: "1",
    ...(tmpdir === undefined ? {} : { TMPDIR: tmpdir }),
    GLOBNOTES_PATH: fixture, GLOBNOTES_INDEX_PATH: `${fixture}/.globnotes`,
    GLOBNOTES_AUTH_TYPE: "none", GLOBNOTES_HOST: "0.0.0.0", GLOBNOTES_PORT: String(port) },
  stdout: "piped", stderr: "piped",
}).spawn();
console.log(JSON.stringify({ label, root, fixture, baseUrl, hostname: "0.0.0.0", args: child.pid }));
const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
let failure;
try {
  let ready = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/_/api/health`, { signal: AbortSignal.timeout(1000) });
      ready = response.status === 200;
      await response.body?.cancel();
      if (ready) break;
    } catch (error) {
      if (!(error instanceof TypeError || error.name === "TimeoutError")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("cached cold-load never served health 200");
  const index = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
  if (index.status !== 200 || !index.headers.get("content-type")?.includes("text/html")) throw new Error("static index not HTML 200");
  const html = await index.text();
  const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map((match) => match[1]);
  if (!assets.some((path) => path.endsWith(".js")) || !assets.some((path) => path.endsWith(".css"))) throw new Error("built JS and CSS missing from index");
  for (const path of assets) {
    const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(5000) });
    const size = (await response.arrayBuffer()).byteLength;
    if (response.status !== 200 || size === 0) throw new Error(`static asset failed: ${path} ${response.status} ${size}`);
    console.log(JSON.stringify({ gate: "static-asset", path, status: response.status, size }));
  }
  const note = await fetch(`${baseUrl}/_/api/notes/ReleaseProbe`, { signal: AbortSignal.timeout(5000) });
  const body = await note.json();
  if (note.status !== 200 || !body.content.includes("Cached cold-load fixture.")) throw new Error("fixture note consumer missing content");
  console.log(JSON.stringify({ gate: "cold-load", label, health: 200, staticIndex: 200, assets: assets.length, noteConsumer: note.status }));
} catch (error) {
  failure = error;
} finally {
  // Always retain startup diagnostics, including when exit races with kill.
  const killTimer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }, 5000);
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
  let status;
  try {
    status = await child.status;
  } finally {
    clearTimeout(killTimer);
  }
  const [stdout, stderr] = await output;
  console.log(`SERVER STDOUT\n${stdout}\nSERVER STDERR\n${stderr}`);
  console.log(JSON.stringify({ serverStatus: status, retainedFixture: fixture }));
}
if (failure) throw failure;
console.log(`COLD-LOAD OK ${label}`);
