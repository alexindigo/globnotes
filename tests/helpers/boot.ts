// SPDX-License-Identifier: LGPL-3.0-only

/** Boot a real globnotes server subprocess for integration tests,
 * mirroring how the Python suite used FastAPI's TestClient. */

import { command, DENO } from "./process.ts";

const SERVER_MAIN = new URL("../../server/main.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/** Auto-created vault dirs, swept at test-process unload so a test that
 * forgets to clean up still leaves no /tmp/globnotes-test-vault-*
 * leftovers. Vaults passed in via GLOBNOTES_PATH are caller-owned and
 * never tracked (restart-style tests reuse them across close()s). */
const trackedVaults = new Set<string>();
globalThis.addEventListener?.("unload", () => {
  for (const vault of trackedVaults) {
    try {
      Deno.removeSync(vault, { recursive: true });
    } catch {
      // already removed (explicit cleanup) or gone
    }
  }
  trackedVaults.clear();
});

export interface TestServer {
  baseUrl: string;
  vault: string;
  pid: number;
  /** Output captured from the server process so far. */
  logs: () => { stderr: string };
  /** Stops the server. Fails, with the server's stderr, when the server had
   * already exited on its own. */
  close: () => Promise<void>;
}

function freePort(hostname: string): number {
  const listener = Deno.listen({ port: 0, hostname });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

/** Server tests listen on loopback. Browser tests pass the local test domain's
 * address as `host` and its browser-facing `origin` (client/tests/e2e/http-origin.mjs). */
export async function bootServer(
  env: Record<string, string>,
  opts: {
    cwd?: string;
    host?: string;
    origin?: (port: number) => string;
  } = {},
): Promise<TestServer> {
  const hostname = opts.host ?? "127.0.0.1";
  const port = freePort(hostname);
  const ownsVault = !env.GLOBNOTES_PATH;
  const vault = env.GLOBNOTES_PATH ??
    (await Deno.makeTempDir({ prefix: "globnotes-test-vault-" }));
  if (ownsVault) trackedVaults.add(vault);
  let stderrText = "";
  // Clean environment: exactly `env` plus the launcher's base, never the
  // test process's (shared, concurrently mutated) environment.
  const child = command(DENO, {
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
      GLOBNOTES_HOST: hostname,
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
  let exited: Deno.CommandStatus | null = null;
  const status = child.status.then((value) => {
    exited = value;
    return value;
  });
  const exitDetail = async (what: string) => {
    const { code, signal } = await status;
    await draining;
    return `${what} (pid ${child.pid}, exit code ${code}${
      signal ? `, signal ${signal}` : ""
    }). stderr:\n${stderrText}`;
  };

  const baseUrl = opts.origin?.(port) ?? `http://127.0.0.1:${port}`;
  // With a path prefix the router only answers under it.
  const prefix = env.GLOBNOTES_PATH_PREFIX ?? "";
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(await exitDetail("server exited before it was healthy"));
    }
    try {
      const res = await fetch(`${baseUrl}${prefix}/_/api/health`);
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
    try {
      child.kill("SIGKILL");
    } catch {
      // exited on its own meanwhile; exitDetail reports how
    }
    throw new Error(await exitDetail("server failed to boot within 15 s"));
  }

  let closed = false;
  return {
    baseUrl,
    vault,
    pid: child.pid,
    logs: () => ({ stderr: stderrText }),
    close: async () => {
      if (closed) return;
      closed = true;
      if (exited) {
        throw new Error(
          await exitDetail("server exited on its own before close()"),
        );
      }
      try {
        child.kill("SIGTERM");
      } catch {
        throw new Error(
          await exitDetail("server exited on its own before close()"),
        );
      }
      await status;
      await draining;
      // The vault is deliberately NOT removed here: restart-style tests
      // reuse the same vault across close()s. Auto-created vault paths
      // are tracked instead and swept at process unload (below), so
      // /tmp never accumulates globnotes-test-vault-* leftovers.
    },
  };
}
