// SPDX-License-Identifier: LGPL-3.0-only
import type { DriverCapabilities } from "../../server/plugins/driver_contract.ts";
import { readManifest } from "../../server/plugins/manifest.ts";
import { pluginFixture } from "./plugin_fixture.ts";

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
