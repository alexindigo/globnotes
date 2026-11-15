import { afterEach, expect, it, vi } from "vitest";
vi.mock("../api.js", () => ({ getPluginHostCatalog: vi.fn(), openPluginHostEvents: vi.fn() }));
vi.mock("../commands.js", () => ({ removeCommandOwner: vi.fn() }));
vi.mock("../pluginSdk.js", () => ({ createPluginSdk: vi.fn() }));
import { createPluginRuntime } from "../pluginRuntime.js";
import { createPluginInventoryController } from "../pluginInventoryController.js";
import { createConnectionLifetime } from "../connectionLifetime.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const catalog = (revision, enabled) => ({ policy: { revision, signature: `r${revision}`, effectiveAutoEnable: true }, plugins: [{ id: "p", enabled }] });
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.controller.dispose(); f.runtime.stop(); } });

async function fixture() {
  const reads = [], close = vi.fn(), read = vi.fn(() => { const d = deferred(); reads.push(d); return d.promise; });
  let token = "token-A", events;
  const lifetime = createConnectionLifetime();
  const runtime = createPluginRuntime({ readCatalog: read, openEvents: async handlers => { events = handlers; return close; }, getSession: () => token, lifetime });
  const start = runtime.start(token); reads[0].resolve(catalog(0, false)); await start;
  const write = vi.fn(async () => ({ policy: catalog(1, true).policy }));
  const controller = createPluginInventoryController({
    getCatalog: () => runtime.catalog.value, getSession: () => token, writable: () => true,
    captureOwner: runtime.captureOwnership, acknowledge: runtime.acknowledgePolicy,
    writeEnabled: write, writePolicy: vi.fn(), refreshCatalog: () => runtime.refresh({ joinLatest: true }),
  });
  const f = { runtime, controller, reads, read, write, close, lifetime,
    invalidate: () => events.onEvent({ event: "invalidate" }),
    replaceSession: () => { token = "token-B"; runtime.stop(); return runtime.start(token); },
  };
  fixtures.push(f);
  const saving = controller.setEnabled("p", true); await flush();
  reads[1].reject(Error("Retain committed recovery after a failed read"));
  expect(await saving).toBe(false);
  expect(controller.snapshot()).toMatchObject({ committed: true, hasWork: true, canRetry: false });
  return f;
}

it("one Review joins an already dispatched event read without another GET or PUT", async () => {
  const f = await fixture(), reviewing = f.controller.review(); await flush();
  f.invalidate(); await flush();
  expect(f.reads).toHaveLength(4);
  f.reads[3].resolve(catalog(1, true)); await flush();
  f.reads[2].resolve(catalog(1, true));
  expect(await reviewing).toBe(true);
  expect(f.controller.hasWork()).toBe(false);
  expect(f.runtime.catalog.value.plugins[0].enabled).toBe(true);
  expect(f.read).toHaveBeenCalledTimes(4);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("Review retains committed recovery when acknowledgement retires an already accepted joined read", async () => {
  const f = await fixture(), reviewing = f.controller.review(); await flush();
  f.invalidate(); await flush();
  f.reads[3].resolve(catalog(1, true)); await flush();
  expect(f.runtime.catalog.value.policy.revision).toBe(1);
  expect(f.runtime.acknowledgePolicy(catalog(2, true).policy, f.runtime.captureOwnership())).toBe(true);
  f.reads[2].resolve(catalog(1, true));
  expect(await reviewing).toBe(false);
  expect(f.controller.snapshot()).toMatchObject({ committed: true, hasWork: true, canRetry: false });
  expect(f.read).toHaveBeenCalledTimes(4);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it.each(["session", "document"])("a Review cannot join the replacement %s lifetime", async ending => {
  const f = await fixture(), reviewing = f.controller.review(); await flush();
  let starting;
  if (ending === "session") starting = f.replaceSession();
  else { f.lifetime.suspendDocument(); f.lifetime.resumeDocument(); }
  expect(f.reads).toHaveLength(4);
  f.reads[3].resolve(catalog(0, false)); if (starting) await starting; else await flush();
  f.reads[2].resolve(catalog(1, true));
  expect(await reviewing).toBe(false);
  expect(f.runtime.catalog.value.policy.revision).toBe(0);
  expect(f.controller.hasWork()).toBe(true);
  expect(f.read).toHaveBeenCalledTimes(4);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("does not invent acceptance or issue a follow-up when a policy floor retires the only read", async () => {
  const f = await fixture(), reviewing = f.controller.review(); await flush();
  f.runtime.acknowledgePolicy({ revision: 2, signature: "another committed policy" }, f.runtime.captureOwnership());
  f.reads[2].resolve(catalog(1, true));
  expect(await reviewing).toBe(false);
  expect(f.controller.hasWork()).toBe(true);
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("a superseded 401 cannot stop the event read joined by Review", async () => {
  const f = await fixture(), reviewing = f.controller.review(); await flush();
  f.invalidate(); await flush();
  f.reads[3].resolve(catalog(1, true)); await flush();
  f.reads[2].reject({ response: { status: 401 } });
  expect(await reviewing).toBe(true);
  expect(f.close).not.toHaveBeenCalled();
  expect(f.read).toHaveBeenCalledTimes(4);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("a current 401 remains unsuccessful and stops the admitted stream", async () => {
  const f = await fixture(), reviewing = f.controller.review(); await flush();
  f.reads[2].reject({ response: { status: 401 } });
  expect(await reviewing).toBe(false);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.runtime.catalog.value).toBeNull();
  expect(f.controller.hasWork()).toBe(true);
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(f.write).toHaveBeenCalledTimes(1);
});
