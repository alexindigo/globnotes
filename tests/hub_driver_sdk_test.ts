// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  storageDriver,
  StorageError,
  type StorageProvider,
} from "../server/plugins/driver_sdk.ts";
import type { ExportItem } from "../server/plugins/driver_contract.ts";
import { driverCapabilities } from "./helpers/driver_fixture.ts";

function fixture() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const calls: { method: string; key: string; condition?: unknown }[] = [];
  let fault: unknown;
  const provider: StorageProvider = {
    conditions: { create: true, update: true, delete: true },
    identity: () =>
      fault
        ? Promise.reject(fault)
        : Promise.resolve({ id: "memory", epoch: "one" }),
    list: (cursor) => {
      if (fault) return Promise.reject(fault);
      const entries = [...objects].map(([key, value]) => ({
        key,
        etag: value.etag,
        size: value.bytes.length,
      }));
      return Promise.resolve({
        entries: entries.slice(Number(cursor ?? 0), Number(cursor ?? 0) + 1),
        ...(Number(cursor ?? 0) + 1 < entries.length
          ? { next: String(Number(cursor ?? 0) + 1) }
          : {}),
      });
    },
    get: (key) => {
      calls.push({ method: "get", key });
      return fault
        ? Promise.reject(fault)
        : objects.has(key)
        ? Promise.resolve(objects.get(key)!)
        : Promise.reject(new StorageError("not_found", { effect: "none" }));
    },
    put: (key, bytes, condition) => {
      calls.push({ method: "put", key, condition });
      if (fault) return Promise.reject(fault);
      objects.set(key, { bytes, etag: "new-etag" });
      return Promise.resolve({ etag: "new-etag" });
    },
    delete: (key, condition) => {
      calls.push({ method: "delete", key, condition });
      if (fault) return Promise.reject(fault);
      objects.delete(key);
      return Promise.resolve();
    },
  };
  return {
    provider,
    objects,
    calls,
    fail: (value: unknown) => {
      fault = value;
    },
  };
}
const item = (
  base: ExportItem["base"] = { absent: true },
  op: "put" | "delete" = "put",
): ExportItem => ({
  id: "one",
  op,
  path: "note.md",
  batch: 1,
  base,
  ...(op === "put" ? { bytes: new TextEncoder().encode("new") } : {}),
});

Deno.test("storage SDK: pages complete only at the end; failed listing and locked access never look empty", async () => {
  const f = fixture(), driver = storageDriver(f.provider);
  f.objects.set("a.md", { bytes: new Uint8Array([1]), etag: "a" });
  f.objects.set("b.md", { bytes: new Uint8Array([2]), etag: "b" });
  assertEquals((await driver.open()).state, "ready");
  const first = await driver.discover({ mode: "snapshot" });
  assertEquals(first.completion, "more");
  assertEquals(first.cursor, "1");
  const last = await driver.discover({
    mode: "snapshot",
    cursor: first.cursor,
  });
  assertEquals(last.completion, "complete");
  assertEquals(last.entries[0], {
    state: "known",
    path: "b.md",
    revision: "b",
    size: 1,
  });
  f.fail(new StorageError("unavailable", { effect: "none" }));
  assertEquals(
    (await driver.discover({ mode: "snapshot", cursor: "1" })).completion,
    "incomplete",
  );
  f.fail(new StorageError("unauthorized", { effect: "none" }));
  assertEquals((await driver.open()).state, "locked");
  assertEquals(
    (await driver.read({ path: "a.md", revision: "a" })).state,
    "locked",
  );
  assertEquals(
    (await driver.discover({ mode: "snapshot" })).entries[0].state,
    "locked",
  );
});

Deno.test("storage SDK: current-only reads refuse a changed ETag, 404 is absent, no synthetic history", async () => {
  const f = fixture(), driver = storageDriver(f.provider);
  f.objects.set("a.md", { bytes: new Uint8Array([1]), etag: "a" });
  assertEquals(await driver.read({ path: "a.md", revision: "old" }), {
    state: "unknown",
    reason: "revision_changed",
  });
  assertEquals(await driver.read({ path: "missing", revision: "old" }), {
    state: "absent",
  });
  const read = await driver.read({ path: "a.md", revision: "a" });
  assertEquals(read, {
    state: "known",
    revision: "a",
    bytes: new Uint8Array([1]),
  });
  assert(!("baseText" in read));
});

Deno.test("storage SDK: native create/update/delete retain their exact condition", async () => {
  const f = fixture(), driver = storageDriver(f.provider);
  await driver.apply([item()]);
  await driver.apply([item({ revision: "old" })]);
  await driver.apply([item({ revision: "old" }, "delete")]);
  assertEquals(
    f.calls.map(({ method, condition }) => ({ method, condition })),
    [
      { method: "put", condition: { ifNoneMatch: "*" } },
      { method: "put", condition: { ifMatch: "old" } },
      { method: "delete", condition: { ifMatch: "old" } },
    ],
  );
});

Deno.test("storage SDK: emulation freshly checks every base and refuses divergence without writing", async () => {
  const f = fixture();
  f.provider.conditions = { create: false, update: false, delete: false };
  const driver = storageDriver(f.provider);
  f.objects.set("note.md", { bytes: new Uint8Array([1]), etag: "old" });
  assertEquals(await driver.apply([item()]), [{
    id: "one",
    state: "conflict",
  }]);
  assertEquals(await driver.apply([item({ revision: "wrong" })]), [{
    id: "one",
    state: "conflict",
  }]);
  assertEquals(await driver.apply([item({ revision: "wrong" }, "delete")]), [{
    id: "one",
    state: "conflict",
  }]);
  assert(f.calls.every(({ method }) => method === "get"));
  assertEquals(
    (await driver.apply([item({ revision: "old" })]))[0].state,
    "settled",
  );
  assertEquals(f.calls.slice(-2).map(({ method }) => method), ["get", "put"]);
  assertEquals(
    (await driver.apply([item({ revision: "new-etag" }, "delete")]))[0].state,
    "settled",
  );
  assertEquals((await driver.apply([item()]))[0].state, "settled");
});

Deno.test("storage SDK: typed effects distinguish conflicts, advice, uncertainty and preflight failures", async () => {
  const f = fixture(), driver = storageDriver(f.provider);
  for (
    const [code, effect, expected] of [
      ["precondition_failed", "none", "conflict"],
      ["network", "unknown", "uncertain"],
      ["unavailable", "unknown", "uncertain"],
      ["rate_limited", "none", "failed"],
    ] as const
  ) {
    f.fail(new StorageError(code, { effect, retryAfterMs: 9000 }));
    const [result] = await driver.apply([item()]);
    assertEquals(result.state, expected);
    if (result.state === "failed") {
      assertEquals(result.error.retryAfterMs, 9000);
    }
  }
  f.fail(new Error("a raw transport failure can contain private input"));
  assertEquals((await driver.apply([item()]))[0].state, "uncertain");
  f.provider.conditions.create = false;
  const emulated = storageDriver(f.provider);
  const [result] = await emulated.apply([item()]);
  assertEquals(result.state, "failed"); // No write was dispatched during its failed check.
  if (result.state === "failed") assertEquals(result.error.message, "network");
  f.fail(
    new StorageError("rate_limited", { effect: "none", retryAfterMs: 12000 }),
  );
  const opened = await driver.open();
  assertEquals(opened.state, "failed");
  if (opened.state === "failed") assertEquals(opened.error.retryAfterMs, 12000);
});

Deno.test("storage SDK: exclusions and names have per-item outcomes without touching storage", async () => {
  const f = fixture();
  f.provider.exclude = (key) => key === "note.md";
  const driver = storageDriver(f.provider);
  assertEquals(await driver.apply([item()]), [{
    id: "one",
    state: "excluded",
  }]);
  f.provider.exclude = () => false;
  f.provider.name = () => ({ ok: false, reason: "name_not_storable" });
  assertEquals(await driver.apply([item()]), [{
    id: "one",
    state: "unsupported",
    reason: "name_not_storable",
  }]);
  assertEquals(f.calls, []);
});

Deno.test("storage SDK: authentication failure stops later sends but preserves earlier receipts", async () => {
  const f = fixture(), driver = storageDriver(f.provider);
  let count = 0;
  f.provider.put = () =>
    ++count === 1
      ? Promise.resolve({ etag: "first" })
      : Promise.reject(new StorageError("unauthorized", { effect: "none" }));
  const results = await driver.apply([item(), { ...item(), id: "two" }, {
    ...item(),
    id: "three",
  }]);
  assertEquals(results.map(({ state }) => state), [
    "settled",
    "failed",
    "failed",
  ]);
  assertEquals(count, 2);
});

Deno.test("storage SDK: declared emulation is allowed and unsupported mutations never reach a provider", async () => {
  const f = fixture();
  f.provider.conditions = { create: false, update: false, delete: false };
  const capabilities = {
    ...driverCapabilities,
    mutations: {
      create: "emulated" as const,
      update: "none" as const,
      delete: "none" as const,
      move: "none" as const,
    },
  };
  const driver = storageDriver(f.provider, {}, capabilities);
  assertEquals((await driver.apply([item()]))[0].state, "settled");
  const count = f.calls.length;
  assertEquals(
    (await driver.apply([item({ revision: "new-etag" })]))[0].state,
    "unsupported",
  );
  assertEquals(
    (await driver.apply([item({ revision: "new-etag" }, "delete")]))[0].state,
    "unsupported",
  );
  assertEquals(f.calls.length, count);
});
