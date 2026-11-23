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

import * as path from "@std/path";
import { DENO } from "./process_values.ts";
import { spawnOwnedChild } from "./owned_child.ts";
import { createFixtureScope } from "./fixture_scope_engine.ts";
import { done, pending, waitUntil } from "./wait.ts";
import { testEnvironment } from "./environment.ts";
import { publishRecord } from "./process_records.ts";
import { boundOperation } from "./owned_operation.ts";
import type { StoredConfig } from "../../server/config.ts";
import {
  admitLayout,
  bindLayout,
  type FixtureLayout,
  fixtureLayout,
  layoutEnvironment,
  prepareFixtureMetadata,
  serverWorkingDirectory,
} from "./fixture_layout.ts";
import type { CompletedBuild } from "./completed_build.ts";
import type { IdentityFixturePayload } from "./identity_fixture.ts";

const SERVER_MAIN = path.fromFileUrl(
  new URL("../../server/main.ts", import.meta.url),
);
const REPO_ROOT = path.fromFileUrl(new URL("../../", import.meta.url));
const LISTENING = /globnotes listening on http:\/\/\S*:(\d+)/;
const SHUTDOWN_GRACE_MS = 5_000;
/** Port protocol shared with subprocess fixtures that emulate the server. */
export const SERVER_PORT_ENV = "GLOBNOTES__SERVER_PORT";

export interface TestServer {
  baseUrl: string;
  vault: string;
  layout: FixtureLayout;
  /** Prepared account input; not active production authority before I14c4. */
  fixtureIdentity?: IdentityFixturePayload | null;
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
  exited: Promise<Deno.CommandStatus>;
  /** Stops the server with a 5 s SIGTERM grace, then owned-child SIGKILL.
   * A cleanly released prior self-exit rejects with UnexpectedServerExitError;
   * cleanup failures remain separate errors or aggregates, never that verdict. */
  close: () => Promise<void>;
}

/** A bare close rejection of this type certifies a self-exited process whose
 * launcher resources were released. Failed cleanup wraps it in AggregateError,
 * which must remain a failure even though the process is no longer running. */
export class UnexpectedServerExitError extends Error {
  override name = "UnexpectedServerExitError";
}

/** A scratch working directory for one server. When the checkout has a
 * client build, the server gets a private copy of it to serve and stamp.
 * Raw native launchers use this same owner and remove it after child exit. */
export const createServerWorkingDirectory = serverWorkingDirectory;

function insideCheckout(dir: string): boolean {
  const root = Deno.realPathSync(REPO_ROOT);
  const real = Deno.realPathSync(dir);
  return real === root || real.startsWith(root + path.SEPARATOR);
}

/** Server tests listen on loopback. Browser tests pass the local test domain's
 * address as `host` and its browser-facing `origin` (client/tests/e2e/http-origin.mjs). */
export async function bootServer(
  inputs: Record<string, unknown>,
  opts: {
    /** Caller-owned app directory (e.g. a fixture client/dist). Default: a
     * scratch dir owned by this server. Never inside the checkout. */
    cwd?: string;
    host?: string;
    origin?: (port: number) => string;
    /** Extra `deno run` flags placed before the server entry point. */
    denoArgs?: string[];
    /** Low-level readiness IO port for lifecycle contracts, not another clock. */
    healthFetch?: typeof fetch;
    /** Per-child pipe consumer for fixture protocols independent of filesystem IO.
     * Called synchronously after captured output; must not throw. */
    observeOutput?: (name: "stdout" | "stderr", chunk: string) => void;
    layout?: FixtureLayout;
    build?: CompletedBuild;
  } = {},
): Promise<TestServer> {
  inputs = { ...inputs };
  if (inputs.fixtureScenario !== undefined) {
    inputs.fixtureScenario = structuredClone(inputs.fixtureScenario);
  }
  const initialAuth = inputs.fixtureAuth;
  if (initialAuth && typeof initialAuth === "object") {
    inputs.fixtureAuth = { ...initialAuth };
  }
  const {
    cwd,
    host,
    origin,
    healthFetch,
    denoArgs,
    observeOutput,
    layout: suppliedLayout,
    build,
  } = opts;
  opts = {
    cwd,
    host,
    origin,
    healthFetch,
    observeOutput,
    denoArgs: [...(denoArgs ?? [])],
    layout: suppliedLayout,
    build,
  };
  const extraArgs = opts.denoArgs!;
  const lifetime = createFixtureScope();
  let returned = false;
  return await lifetime.prepare(async (scope) => {
    const fixture = testEnvironment(inputs);
    const hostname = opts.host ?? "127.0.0.1";
    const healthFetch = opts.healthFetch ?? fetch;
    const layout = opts.layout ??
      await fixtureLayout(scope, fixture.values, {
        cwd: opts.cwd,
        build: opts.build,
        retainPersistent: () => returned,
      });
    bindLayout(layout, scope);
    if (
      opts.cwd !== undefined &&
      (await scope.admit(() => insideCheckout(opts.cwd!))).value
    ) {
      throw new Error(
        `test servers must not run in the checkout (cwd ${opts.cwd}): the ` +
          "server rewrites the cwd-relative client/dist/index.html at boot",
      );
    }
    if (
      (await admitLayout(layout, scope, () => insideCheckout(layout.cwd))).value
    ) {
      throw new TypeError("Owned layout cwd must not be inside the checkout");
    }
    if (opts.layout && (opts.cwd !== undefined || opts.build !== undefined)) {
      throw new TypeError("An owned layout already binds its cwd and build");
    }
    if (opts.layout) {
      for (
        const key of [
          "GLOBNOTES__VAULTS_BASEPATH",
          "GLOBNOTES_GLOBNOTES_PATH",
          "GLOBNOTES__METADATA_PATH",
        ]
      ) {
        const supplied = fixture.values[key];
        if (
          supplied !== undefined &&
          (supplied ? path.resolve(supplied) : supplied) !==
            layout.environment[key]
        ) {
          throw new TypeError(
            `Boot cannot replace its owned layout binding: ${key}`,
          );
        }
      }
    }
    const env = { ...layoutEnvironment(layout), ...fixture.values };
    // Normalize explicit child-facing paths once; leave omitted overrides absent.
    for (
      const key of [
        "GLOBNOTES__VAULTS_BASEPATH",
        "GLOBNOTES_GLOBNOTES_PATH",
        "GLOBNOTES__METADATA_PATH",
      ]
    ) {
      if (layout.environment[key] !== undefined) {
        env[key] = layout.environment[key];
      }
    }
    const vault = layout.vault, metadata = layout.metadata;
    if (fixture.fixtureAuth) {
      await prepareFixtureMetadata(layout, scope);
      await admitLayout(layout, scope, async (signal) => {
        let saved: StoredConfig = {};
        try {
          saved = JSON.parse(
            await Deno.readTextFile(path.join(metadata, "config.json")),
          );
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await publishRecord(
          path.join(metadata, "config.json"),
          JSON.stringify({ ...saved, ...fixture.fixtureAuth }),
          { signal },
        );
      });
    }
    const args = [
      "run",
      "--unstable-worker-options",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      ...extraArgs,
      SERVER_MAIN,
    ];
    // Clean environment: exactly `env` plus the launcher's base, never the
    // test process's (shared, concurrently mutated) environment.
    // Register the existing drain join before child acquisition: LIFO reaps first,
    // then joins pipe capture, then releases the child's working directory.
    let draining: Promise<unknown> = Promise.resolve();
    scope.defer(() => draining);
    const child = (await spawnOwnedChild(scope, DENO, {
      args,
      cwd: layout.cwd,
      env: {
        ...env,
        [SERVER_PORT_ENV]: "0",
        GLOBNOTES__SERVER_HOST: hostname,
      },
      stdout: "piped",
      stderr: "piped",
    })).value;

    // Drain both pipes so the child never blocks on a full pipe buffer.
    const output = { stdout: "", stderr: "" };
    const drain = (name: "stdout" | "stderr") =>
      child[name]
        .pipeThrough(new TextDecoderStream())
        .pipeTo(
          new WritableStream({
            write(chunk) {
              output[name] += chunk;
              observeOutput?.(name, chunk);
            },
          }),
        )
        .catch(() => {});
    draining = Promise.all([drain("stdout"), drain("stderr")]);
    const status = child.exited;
    const exitDetail = async (what: string) => {
      const { code, signal } = await status;
      await draining;
      return `${what} (pid ${child.pid}, exit code ${code}${
        signal ? `, signal ${signal}` : ""
      }). stderr:\n${output.stderr}`;
    };

    // With a path prefix the router only answers under it.
    const prefix = env.GLOBNOTES__SERVER_PATHPREFIX ?? "";
    let port: number | null = null;
    const ownerGone = new AbortController();
    status.then(
      (value) => ownerGone.abort(Error(`server exited: ${value.code}`)),
      (error) => ownerGone.abort(error),
    );
    try {
      await waitUntil(async (signal) => {
        port ??= Number(LISTENING.exec(output.stdout)?.[1]) || null;
        if (port === null) return pending({ port: null });
        const listeningPort = port;
        try {
          const res = (await admitLayout(layout, scope, async (scopeSignal) => {
            const requestSignal = AbortSignal.any([
              signal,
              ownerGone.signal,
              scopeSignal,
            ]);
            return await boundOperation<Response>({
              signal: requestSignal,
              // Cancellation-ignoring disposal must not retain health admission.
              // P04 observes its rejection and disposes late responses as well.
              dispose: (response) => response.body?.cancel(),
            }, (signal) =>
              healthFetch(
                `${
                  origin?.(listeningPort) ??
                    `http://127.0.0.1:${listeningPort}`
                }${prefix}` +
                  "/_/api/health",
                {
                  signal,
                },
              ));
          })).value;
          // The successful response may have been admitted before actual exit.
          // Readiness cannot outlive the process that supplied that response.
          ownerGone.signal.throwIfAborted();
          return res.ok ? done() : pending({ port, health: res.status });
        } catch (error) {
          if (
            signal.aborted || ownerGone.signal.aborted || scope.signal.aborted
          ) {
            throw error;
          }
          return pending({ port, health: String(error) }); // not up yet
        }
      }, {
        label: `test server ${child.pid} healthy`,
        intervalMs: 50,
        children: [{ pid: child.pid, status: child.status }],
      });
      ownerGone.signal.throwIfAborted();
    } catch (error) {
      if (child.status()) {
        throw new Error(
          await exitDetail("server exited before it was healthy"),
        );
      }
      await child.reap();
      throw new Error(
        `${await exitDetail(
          port === null
            ? "server never reported its listening port"
            : "server failed to become healthy in time",
        )}\n${error instanceof Error ? error.message : error}`,
      );
    }
    const boundPort: number = port!;

    let closing: Promise<void> | undefined;
    const server: TestServer = {
      baseUrl: origin?.(boundPort) ?? `http://127.0.0.1:${boundPort}`,
      vault,
      layout,
      fixtureIdentity: fixture.fixtureIdentity,
      port: boundPort,
      pid: child.pid,
      args,
      output,
      logs: () => ({ ...output }),
      status: child.status,
      exited: status,
      close: () =>
        closing ??= (async () => {
          if (scope.signal.aborted) {
            await lifetime.close();
            return;
          }
          try {
            if (child.status()) {
              throw new UnexpectedServerExitError(
                await exitDetail("server exited on its own before close()"),
              );
            }
            await child.terminate(SHUTDOWN_GRACE_MS);
          } catch (error) {
            await lifetime.close(error);
            throw error;
          }
          await lifetime.close();
          // Compatibility boot retains successful persistent roots for restart.
          // Explicit layouts instead remain owned by their enclosing scope.
        })(),
    };
    ownerGone.signal.throwIfAborted();
    // All caller code, including origin(), has run. Scope retirement need not
    // have produced a child-exit notification yet; fence it at the handoff too.
    scope.assertCurrent();
    returned = true;
    return server;
  });
}
