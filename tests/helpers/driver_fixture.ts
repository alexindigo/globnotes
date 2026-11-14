// SPDX-License-Identifier: LGPL-3.0-only
import type { DriverCapabilities } from "../../server/plugins/driver_contract.ts";
import { readManifest } from "../../server/plugins/manifest.ts";
import { pluginFixture } from "./plugin_fixture.ts";
import { bootServer } from "./boot.ts";
import { assert, assertEquals } from "@std/assert";

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
export async function storageServerFixture(authorities: string[]) {
  const fixture = await pluginFixture();
  const root = new URL(
    "../fixtures/plugins/globnotes-test-driver/",
    import.meta.url,
  );
  const declaration = JSON.parse(
    await Deno.readTextFile(new URL("manifest.json", root)),
  );
  declaration.capabilities.network = authorities;
  await fixture.install("globnotes-test-driver", declaration, {
    "driver.js": await Deno.readTextFile(new URL("driver.js", root)),
  });
  const env = {
    GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES__METADATA_PATH: fixture.metadataBase,
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false",
  };
  let server = await bootServer(env);
  const packets: string[] = [];
  async function call(route: string, method = "GET", body?: unknown) {
    const response = await fetch(`${server.baseUrl}/_/api/${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    packets.push(text);
    assert(response.ok, `${method} ${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
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
  return {
    ...fixture,
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
    server: () => server,
    async add(baseUrl: string, token: string, label = "Remote", settings = {}) {
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
      await server.close();
      server = await bootServer({ ...env, ...overrides });
    },
    async close() {
      await server.close();
      await fixture.dispose();
    },
  };
}
