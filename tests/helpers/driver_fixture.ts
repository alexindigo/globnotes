// SPDX-License-Identifier: LGPL-3.0-only
import type { DriverCapabilities } from "../../server/plugins/driver_contract.ts";
import { readManifest } from "../../server/plugins/manifest.ts";
import { pluginFixture } from "./plugin_fixture.ts";
import { scopedPluginFixture } from "./plugin_fixture_engine.ts";
import { bootServer } from "./boot.ts";
import { assert, assertEquals } from "@std/assert";
import { createFixtureScope } from "./fixture_scope_engine.ts";
import { boundOperation } from "./owned_operation.ts";
import { fixtureScope } from "./fixture_scope.ts";
import { startupFailurePrefix } from "./driver_startup_schema.ts";
import type { TestServer } from "./boot.ts";
import {
  bindDriverStartup,
  createDriverStartupDirectory,
} from "./driver_startup.ts";

export const driverCapabilities: DriverCapabilities = {
  discovery: { snapshot: true, delta: false },
  revisions: "exact",
  mutations: {
    create: "conditional",
    update: "conditional",
    delete: "conditional",
    move: "none",
  },
  groups: "none",
  history: { baseText: false },
  limits: { maxBatch: 64 },
};
export const driverDeclaration = {
  entry: "driver.js",
  apiVersion: 1,
  settings: [{ key: "prefix", label: "Prefix", type: "text", default: "" }],
  secrets: [{ key: "token", label: "Access token" }],
  capabilities: driverCapabilities,
};
export const minimalDriver = `export function activate(ctx) {
  ctx.driver.serve({
    open: () => ({ state: 'ready', endpoint: {id:'memory',epoch:'1'}, scope:'all' }),
    discover: () => ({ endpoint:{id:'memory',epoch:'1'},scope:'all',mode:'snapshot',entries:[],completion:'complete' }),
    read: () => ({state:'absent'}),
    apply: (items) => items.map(item => ({id:item.id,state:'settled',...(item.op==='put'?{revision:'receipt'}:{})})),
    close() {},
  });
}`;
export async function driverFixture(
  source = minimalDriver,
  declaration: Record<string, unknown> = {},
) {
  const fixture = await pluginFixture();
  const dir = await fixture.install("test-driver", {
    driver: { ...driverDeclaration, ...declaration },
    capabilities: { network: false, imports: false },
  }, { "driver.js": source });
  return { ...fixture, dir, manifest: readManifest(dir) };
}

/** Installs only the test-owned fixture plugin; uses actual server controls and
 * network consent, never a preapproved production policy or direct Worker RPC. */
export async function storageServerFixture(
  authorities: string[],
  options: {
    observedTime?: number;
    native?: boolean;
    /** Low-level lifecycle contract port; ordinary scenarios use native fetch. */
    requestFetch?: typeof fetch;
  } = {},
) {
  const { observedTime: initialTime, native, requestFetch = fetch } = options;
  const network = [...authorities];
  const lifetime = createFixtureScope();
  return await lifetime.prepare(async (scope) => {
    const fixture = await scopedPluginFixture(scope);
    const startup = await createDriverStartupDirectory(scope, fixture);
    const root = new URL(
      "../fixtures/plugins/globnotes-test-driver/",
      import.meta.url,
    );
    const declaration = (await fixture.admit(async () =>
      JSON.parse(await Deno.readTextFile(new URL("manifest.json", root)))
    )).value;
    declaration.capabilities.network = network;
    if (native) {
      declaration.driver.entry = "native.js";
      declaration.driver.capabilities.discovery.delta = true;
      declaration.driver.capabilities.groups = "atomic";
    }
    await fixture.admit(async () => {
      await fixture.install("globnotes-test-driver", declaration, {
        "driver.js": await Deno.readTextFile(new URL("driver.js", root)),
        ...(native
          ? { "native.js": await Deno.readTextFile(new URL("native.js", root)) }
          : {}),
      });
    });
    const env = {
      GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES__METADATA_PATH: fixture.metadataBase,
      fixtureAuth: { auth_type: "none" },
      GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false",
    };
    // Control only this owned subprocess's observed-time seam. No process env,
    // product route or production clock implementation is changed by the fixture.
    let observedTime = initialTime ?? 0;
    const clockFile = `${fixture.root}/observed-time.json`;
    const preload = `${fixture.root}/observed-time.mjs`;
    const clock = initialTime === undefined ? null : {
      now: () =>
        observedTime,
      advance: scope.bind((milliseconds: number) => {
        observedTime += milliseconds;
        const next = `${clockFile}.next`;
        Deno.writeTextFileSync(next, JSON.stringify(observedTime));
        Deno.renameSync(next, clockFile);
      }),
    };
    const observe = `import { observeDriverStartup } from ${
      JSON.stringify(
        new URL("./driver_startup_preload.ts", import.meta.url).href,
      )
    }; observeDriverStartup(${JSON.stringify(startup.path)});\n`;
    await fixture.admit(() => {
      Deno.writeTextFileSync(preload, observe);
      if (clock) {
        Deno.writeTextFileSync(clockFile, JSON.stringify(observedTime));
        Deno.writeTextFileSync(
          preload,
          observe + `import { processClock } from ${
            JSON.stringify(
              new URL("../../server/observed_time.ts", import.meta.url).href,
            )
          };\nprocessClock.now = () => JSON.parse(Deno.readTextFileSync(${
            JSON.stringify(clockFile)
          }));\n`,
        );
      }
    });
    const serverOptions = { denoArgs: ["--preload", preload] };
    const observationFailures = new WeakMap<TestServer, AbortSignal>();
    const boot = async (overrides: Record<string, unknown> = {}) => {
      const failure = new AbortController();
      let stderr = "";
      const observeOutput = (name: "stdout" | "stderr", chunk: string) => {
        if (name !== "stderr") return;
        stderr += chunk;
        for (;;) {
          const newline = stderr.indexOf("\n");
          if (newline < 0) return;
          const line = stderr.slice(0, newline);
          stderr = stderr.slice(newline + 1);
          if (!line.startsWith(startupFailurePrefix)) continue;
          try {
            const detail = JSON.parse(line.slice(startupFailurePrefix.length));
            failure.abort(
              Error(`driver startup observation failed: ${detail.failure}`),
            );
          } catch (error) {
            failure.abort(error);
          }
        }
      };
      const admitted = await fixture.admit(() =>
        scope.acquire(
          () =>
            bootServer({ ...env, ...overrides }, {
              ...serverOptions,
              observeOutput,
            }),
          (server) => server.close(),
        )
      );
      const child = admitted.value.value;
      observationFailures.set(child, failure.signal);
      failure.signal.throwIfAborted();
      return child;
    };
    let server = await boot();
    const packets: string[] = [];
    async function call(route: string, method = "GET", body?: unknown) {
      return (await fixture.admit(async (signal) => {
        signal = AbortSignal.any([signal, observationFailures.get(server)!]);
        const response = await boundOperation({
          signal,
          dispose: (response: Response) =>
            signal.aborted ? response.body?.cancel() : undefined,
        }, (requestSignal) =>
          requestFetch(
            `${server.baseUrl}/_/api/${route}`,
            {
              method,
              signal: requestSignal,
              headers: { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            },
          ));
        const text = await fixtureScope(async (bodyScope) => {
          // Acquire the lock before reading: only this reader can cancel a locked
          // body. Neither an ignored read nor ignored cancellation owns admission.
          const reader = (await bodyScope.acquire(() =>
            response.body?.getReader(), (reader) => {
            if (!reader) {
              return;
            }
            try {
              reader.cancel().catch(() => {});
            } finally {
              reader.releaseLock();
            }
          })).value;
          return await boundOperation(
            { signal, dispose: () => {} },
            async () => {
              if (!reader) {
                return "";
              }
              const decoder = new TextDecoder();
              let text = "";
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) {
                  return text + decoder.decode();
                }
                text += decoder.decode(chunk.value, { stream: true });
              }
            },
          );
        });
        signal.throwIfAborted();
        packets.push(text);
        assert(response.ok, `${method} ${route}: ${response.status} ${text}`);
        return text ? JSON.parse(text) : null;
      })).value;
    }
    const view = () => call("drivers");
    const one = async (id: string) =>
      (await view()).instances.find((row: { id: string }) => row.id === id);
    const configure = async (id: string, changes: Record<string, unknown>) => {
      const before = await one(id);
      return await call(`drivers/${id}`, "PUT", {
        revision: before.revision,
        label: before.label,
        settings: before.settings,
        enabled: before.enabled,
        ...changes,
      });
    };
    const key = async (id: string, token: string) =>
      call(`drivers/${id}/secrets/token`, "PUT", {
        revision: (await one(id)).revision,
        value: token,
      });
    const sync = async (id: string) => {
      await call(`drivers/${id}/sync`, "POST", {
        revision: (await one(id)).revision,
      });
      return await one(id);
    };
    const decide = async (id: string, action: string, paths?: string[]) => {
      const row = await one(id);
      await call(`drivers/${id}/decisions`, "POST", {
        instanceRevision: row.revision,
        attentionRevision: row.attention.revision,
        action,
        ...(paths ? { paths } : {}),
      });
      return await one(id);
    };
    const approve = async (allowNetwork = true) => {
      const permission = await call(
        "plugin-host/globnotes-test-driver/permissions",
      );
      await call("plugin-host/globnotes-test-driver/permissions", "PUT", {
        revision: permission.revision,
        signature: permission.signature,
        requestSourceKey: permission.requestSourceKey,
        requestSourceRevision: permission.requestSourceRevision,
        allowNetwork,
        approvedNetwork: permission.requestedNetwork,
        approvedImports: [],
      });
    };
    const catalog = await call("plugin-host");
    await call("plugin-host/globnotes-test-driver/enabled", "PUT", {
      enabled: true,
      revision: catalog.policy.revision,
      signature: catalog.policy.signature,
    });
    await approve();
    let closing: Promise<void> | undefined;
    let replacement: Promise<unknown> = Promise.resolve();
    return {
      ...fixture,
      clock,
      call,
      packets,
      view,
      one,
      configure,
      key,
      sync,
      // Fault scenarios own the export admission boundary. Preparing a one-shot
      // fault after a live note write races the supervisor's background exporter.
      async exportPrepared(id: string, prepare: () => Promise<void>) {
        assertEquals((await one(id)).enabled, true);
        await configure(id, { enabled: false });
        await prepare();
        await configure(id, { enabled: true });
        return await one(id);
      },
      decide,
      approve,
      server: scope.bind(() => server),
      async add(
        baseUrl: string,
        token: string,
        label = "Remote",
        settings = {},
      ) {
        const created = await call("drivers", "POST", {
          plugin: "globnotes-test-driver",
          label,
          settings: { baseUrl, ...settings },
        });
        assertEquals((await one(created.id)).enabled, false);
        await key(created.id, token);
        await configure(created.id, { enabled: true });
        return created.id as string;
      },
      async restart(overrides: Record<string, unknown> = {}) {
        const captured = { ...overrides };
        const previous = replacement;
        const next = fixture.admit(async (signal) => {
          // Reserve the whole close/boot/bind sequence before its first await.
          await previous;
          signal.throwIfAborted();
          await server.close();
          signal.throwIfAborted();
          server = await boot(captured);
          return bindDriverStartup(scope, startup, server, () => server, {
            signal: observationFailures.get(server),
          });
        });
        replacement = next.then(() => undefined, () => undefined);
        return (await next).value;
      },
      close() {
        return closing ??= lifetime.close();
      },
    };
  });
}
