// SPDX-License-Identifier: LGPL-3.0-only

/** Boot a real globnotes server subprocess for integration tests,
 * mirroring how the Python suite used FastAPI's TestClient.
 *
 * The launcher owns the child's resources: a clean environment
 * (tests/helpers/process.ts), its port — the server binds port 0 itself and
 * reports the bound port on its "globnotes listening on" line, so no other
 * process can take it between choice and bind — and its lifetime (an early
 * exit fails with the server's own stderr). */

import { command, DENO } from "./process.ts";

const SERVER_MAIN = new URL("../../server/main.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const LISTENING = /globnotes listening on http:\/\/\S*:(\d+)/;

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
  /** The port the server bound (it chose it itself). */
  port: number;
  pid: number;
  /** The exact `deno` arguments the server was started with. */
  args: string[];
  /** Live output captured from the server process. */
  output: { stdout: string; stderr: string };
  logs: () => { stdout: string; stderr: string };
  /** The exit status once the server process has exited, else null. */
  status: () => Deno.CommandStatus | null;
  /** Stops the server. Fails, with the server's stderr, when the server had
   * already exited on its own. */
  close: () => Promise<void>;
}

/** Server tests listen on loopback. Browser tests pass the local test domain's
 * address as `host` and its browser-facing `origin` (client/tests/e2e/http-origin.mjs). */
export async function bootServer(
  env: Record<string, string>,
  opts: {
    cwd?: string;
    host?: string;
    origin?: (port: number) => string;
    /** Extra `deno run` flags placed before the server entry point. */
    denoArgs?: string[];
    /** Readiness deadline (listening line and health). */
    readyMs?: number;
  } = {},
): Promise<TestServer> {
  const hostname = opts.host ?? "127.0.0.1";
  const ownsVault = !env.GLOBNOTES_PATH;
  const vault = env.GLOBNOTES_PATH ??
    (await Deno.makeTempDir({ prefix: "globnotes-test-vault-" }));
  if (ownsVault) trackedVaults.add(vault);
  const args = [
    "run",
    "--unstable-worker-options",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    ...(opts.denoArgs ?? []),
    SERVER_MAIN,
  ];
  // Clean environment: exactly `env` plus the launcher's base, never the
  // test process's (shared, concurrently mutated) environment.
  const child = command(DENO, {
    args,
    cwd: opts.cwd ?? REPO_ROOT,
    env: {
      ...env,
      GLOBNOTES_PATH: vault,
      GLOBNOTES_PORT: "0",
      GLOBNOTES_HOST: hostname,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drain both pipes so the child never blocks on a full pipe buffer.
  const output = { stdout: "", stderr: "" };
  const drain = (name: "stdout" | "stderr") =>
    child[name]
      .pipeThrough(new TextDecoderStream())
      .pipeTo(
        new WritableStream({
          write(chunk) {
            output[name] += chunk;
          },
        }),
      )
      .catch(() => {});
  const draining = Promise.all([drain("stdout"), drain("stderr")]);
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
    }). stderr:\n${output.stderr}`;
  };

  // With a path prefix the router only answers under it.
  const prefix = env.GLOBNOTES_PATH_PREFIX ?? "";
  const deadline = Date.now() + (opts.readyMs ?? 15_000);
  let port: number | null = null;
  let up = false;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(await exitDetail("server exited before it was healthy"));
    }
    port ??= Number(LISTENING.exec(output.stdout)?.[1]) || null;
    if (port !== null) {
      try {
        const res = await fetch(
          `${opts.origin?.(port) ?? `http://127.0.0.1:${port}`}${prefix}` +
            "/_/api/health",
          { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) },
        );
        await res.body?.cancel();
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
    }
    await new Promise((r) => setTimeout(r, port === null ? 20 : 100));
  }
  if (!up || port === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // exited on its own meanwhile; exitDetail reports how
    }
    throw new Error(
      await exitDetail(
        port === null
          ? "server never reported its listening port"
          : "server failed to become healthy in time",
      ),
    );
  }

  let closed = false;
  return {
    baseUrl: opts.origin?.(port) ?? `http://127.0.0.1:${port}`,
    vault,
    port,
    pid: child.pid,
    args,
    output,
    logs: () => ({ ...output }),
    status: () => exited,
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
