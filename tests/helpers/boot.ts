// SPDX-License-Identifier: LGPL-3.0-only

/** Boot a real globnotes server subprocess for integration tests,
 * mirroring how the Python suite used FastAPI's TestClient.
 *
 * The launcher owns the child's resources: a clean environment
 * (tests/helpers/process.ts), its port — the server binds port 0 itself and
 * reports the bound port on its "globnotes listening on" line, so no other
 * process can take it between choice and bind — its working directory (a
 * scratch dir per boot, never the checkout: the server rewrites the
 * cwd-relative client/dist/index.html at boot) — and its lifetime (an early
 * exit fails with the server's own stderr). Readiness (listening line and
 * health) is one shared wait with the suite's single bound
 * (tests/helpers/wait.ts). */

import { copy, existsSync } from "@std/fs";
import * as path from "@std/path";
import { command, DENO } from "./process.ts";
import { done, pending, waitUntil } from "./wait.ts";

const SERVER_MAIN = new URL("../../server/main.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const REPO_DIST = path.join(REPO_ROOT, "client", "dist");
const LISTENING = /globnotes listening on http:\/\/\S*:(\d+)/;
const SHUTDOWN_GRACE_MS = 5_000;
/** Port protocol shared with subprocess fixtures that emulate the server. */
export const SERVER_PORT_ENV = "GLOBNOTES_PORT";

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
  /** Stops the server with a 5 s SIGTERM grace, then owned-child SIGKILL.
   * Fails, with stderr, when the server had already exited on its own. */
  close: () => Promise<void>;
}

/** A scratch working directory for one server. When the checkout has a
 * client build, the server gets a private copy of it to serve and stamp. */
async function scratchCwd(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "globnotes-test-cwd-" });
  if (existsSync(REPO_DIST)) {
    await copy(REPO_DIST, path.join(dir, "client", "dist"));
  }
  return dir;
}

function insideCheckout(dir: string): boolean {
  const root = Deno.realPathSync(REPO_ROOT);
  const real = Deno.realPathSync(dir);
  return real === root || real.startsWith(root + path.SEPARATOR);
}

/** Server tests listen on loopback. Browser tests pass the local test domain's
 * address as `host` and its browser-facing `origin` (client/tests/e2e/http-origin.mjs). */
export async function bootServer(
  env: Record<string, string>,
  opts: {
    /** Caller-owned app directory (e.g. a fixture client/dist). Default: a
     * scratch dir owned by this server. Never inside the checkout. */
    cwd?: string;
    host?: string;
    origin?: (port: number) => string;
    /** Extra `deno run` flags placed before the server entry point. */
    denoArgs?: string[];
  } = {},
): Promise<TestServer> {
  const hostname = opts.host ?? "127.0.0.1";
  const ownsVault = !env.GLOBNOTES_PATH;
  const vault = env.GLOBNOTES_PATH ??
    (await Deno.makeTempDir({ prefix: "globnotes-test-vault-" }));
  if (ownsVault) trackedVaults.add(vault);
  if (opts.cwd !== undefined && insideCheckout(opts.cwd)) {
    throw new Error(
      `test servers must not run in the checkout (cwd ${opts.cwd}): the ` +
        "server rewrites the cwd-relative client/dist/index.html at boot",
    );
  }
  const ownedCwd = opts.cwd === undefined ? await scratchCwd() : null;
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
    cwd: opts.cwd ?? ownedCwd!,
    env: {
      ...env,
      GLOBNOTES_PATH: vault,
      [SERVER_PORT_ENV]: "0",
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
  let cwdReleased = false;
  const releaseCwd = async () => {
    if (!ownedCwd || cwdReleased) return;
    cwdReleased = true;
    await Deno.remove(ownedCwd, { recursive: true });
  };
  const exitDetail = async (what: string) => {
    const { code, signal } = await status;
    await draining;
    await releaseCwd();
    return `${what} (pid ${child.pid}, exit code ${code}${
      signal ? `, signal ${signal}` : ""
    }). stderr:\n${output.stderr}`;
  };

  // With a path prefix the router only answers under it.
  const prefix = env.GLOBNOTES_PATH_PREFIX ?? "";
  let port: number | null = null;
  try {
    await waitUntil(async (signal) => {
      port ??= Number(LISTENING.exec(output.stdout)?.[1]) || null;
      if (port === null) return pending({ port: null });
      try {
        const res = await fetch(
          `${opts.origin?.(port) ?? `http://127.0.0.1:${port}`}${prefix}` +
            "/_/api/health",
          { signal },
        );
        await res.body?.cancel();
        return res.ok ? done() : pending({ port, health: res.status });
      } catch (error) {
        if (signal.aborted) throw error;
        return pending({ port, health: String(error) }); // not up yet
      }
    }, {
      label: `test server ${child.pid} healthy`,
      intervalMs: 50,
      children: [{ pid: child.pid, status: () => exited }],
    });
  } catch (error) {
    if (exited) {
      throw new Error(await exitDetail("server exited before it was healthy"));
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // exited on its own meanwhile; exitDetail reports how
    }
    throw new Error(
      `${await exitDetail(
        port === null
          ? "server never reported its listening port"
          : "server failed to become healthy in time",
      )}\n${error instanceof Error ? error.message : error}`,
    );
  }
  const boundPort: number = port!;

  let closed = false;
  return {
    baseUrl: opts.origin?.(boundPort) ?? `http://127.0.0.1:${boundPort}`,
    vault,
    port: boundPort,
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
      // Lifetime belongs to this launcher for every caller. A server which
      // ignores SIGTERM must not keep close() (or its pipes/cwd) alive forever.
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* the owned child already exited */ }
      }, SHUTDOWN_GRACE_MS);
      try {
        try {
          child.kill("SIGTERM");
        } catch {
          throw new Error(
            await exitDetail("server exited on its own before close()"),
          );
        }
        await status;
      } finally {
        clearTimeout(killTimer);
      }
      await draining;
      await releaseCwd();
      // The vault is deliberately NOT removed here: restart-style tests
      // reuse the same vault across close()s. Auto-created vault paths
      // are tracked instead and swept at process unload (below), so
      // /tmp never accumulates globnotes-test-vault-* leftovers.
    },
  };
}
