// SPDX-License-Identifier: LGPL-3.0-only

/** Boot a real globnotes server subprocess for integration tests,
 * mirroring how the Python suite used FastAPI's TestClient. */

const SERVER_MAIN = new URL("../../server/main.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const DENO = Deno.execPath();

export interface TestServer {
  baseUrl: string;
  vault: string;
  close: () => Promise<void>;
}

function freePort(): number {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

export async function bootServer(
  env: Record<string, string>,
  opts: { cwd?: string } = {},
): Promise<TestServer> {
  const port = freePort();
  const vault = env.GLOBNOTES_PATH ??
    (await Deno.makeTempDir({ prefix: "globnotes-test-vault-" }));
  let stderrText = "";
  const child = new Deno.Command(DENO, {
    args: [
      "run",
      "--unstable-worker-options",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      SERVER_MAIN,
    ],
    cwd: opts.cwd ?? REPO_ROOT,
    env: {
      ...env,
      GLOBNOTES_PATH: vault,
      GLOBNOTES_PORT: String(port),
      GLOBNOTES_HOST: "127.0.0.1",
      NO_COLOR: "1",
    },
    stdout: "null",
    stderr: "piped",
  }).spawn();

  // Drain stderr so the child never blocks on a full pipe buffer.
  const draining = child.stderr
    .pipeThrough(new TextDecoderStream())
    .pipeTo(
      new WritableStream({
        write(chunk) {
          stderrText += chunk;
        },
      }),
    )
    .catch(() => {});

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/_/api/health`);
      await res.body?.cancel();
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    child.kill("SIGKILL");
    await draining;
    throw new Error(`server failed to boot. stderr:\n${stderrText}`);
  }

  return {
    baseUrl,
    vault,
    close: async () => {
      child.kill("SIGTERM");
      try {
        await child.status;
      } catch {
        // already gone
      }
    },
  };
}
