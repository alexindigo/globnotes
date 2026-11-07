// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  type DiscoveryPage,
  DRIVER_LIMITS,
  DriverContractError,
  driverPath,
  type ExportItem,
  validateDiscoveryPage,
  validateDriverCapabilities,
  validateDriverEnvelope,
  validateExportItems,
  validateMutationResults,
  validateOpenResult,
  validateReadResult,
} from "../server/plugins/driver_contract.ts";
import { readManifest, workerPermissions } from "../server/plugins/manifest.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import {
  driverCapabilities as caps,
  driverDeclaration,
  driverFixture,
} from "./helpers/driver_fixture.ts";

const binding = { endpoint: { id: "remote", epoch: "1" }, scope: "all" };
const page: DiscoveryPage = {
  ...binding,
  mode: "snapshot" as const,
  entries: [{ state: "known", path: "A.md", revision: "opaque" }],
  completion: "complete",
};
const items: ExportItem[] = [{
  id: "1",
  op: "put",
  path: "A.md",
  batch: 1,
  bytes: new Uint8Array([1]),
  base: { absent: true },
}];
const invalid = (fn: () => unknown) => assertThrows(fn, DriverContractError);

Deno.test("drivers: strict static capabilities and result variants", () => {
  assertEquals(validateDriverCapabilities(caps), caps);
  for (
    const value of [
      null,
      {},
      { ...caps, extra: true },
      { ...caps, discovery: { snapshot: false, delta: true } },
      { ...caps, limits: { maxBatch: 65 } },
      { ...caps, limits: { maxBatch: 0 } },
      { ...caps, revisions: "hash" },
    ]
  ) invalid(() => validateDriverCapabilities(value));
  assertEquals(validateOpenResult({ state: "ready", ...binding }), {
    state: "ready",
    ...binding,
  });
  for (
    const value of [
      { state: "ready", ...binding, peer: "other" },
      { state: "locked", reason: "key", endpoint: binding.endpoint },
      { state: "failed", error: { code: "network_denied", token: "never" } },
      { state: "failed", error: { code: "offline", retryAfterMs: -1 } },
    ]
  ) invalid(() => validateOpenResult(value));
  assertEquals(validateOpenResult({ state: "locked", reason: "needs key" }), {
    state: "locked",
    reason: "needs key",
  });
  assertEquals(
    validateReadResult({
      state: "known",
      revision: "r",
      bytes: new Uint8Array([1]),
    }, caps),
    { state: "known", revision: "r", bytes: new Uint8Array([1]) },
  );
  for (
    const value of [{ state: "known", revision: "r", bytes: "text" }, {
      state: "absent",
      reason: "not found",
    }, {
      state: "known",
      revision: "r",
      bytes: new Uint8Array(0),
      baseText: "not advertised",
    }, {
      state: "known",
      revision: "r",
      bytes: new Uint8Array(DRIVER_LIMITS.bodyBytes + 1),
    }]
  ) invalid(() => validateReadResult(value, caps));
});

Deno.test("drivers: complete discovery is bound, bounded, unique and explicit about absence", () => {
  assertEquals(
    validateDiscoveryPage(page, caps, { mode: "snapshot" }, binding),
    page,
  );
  for (
    const value of [
      { ...page, endpoint: { ...binding.endpoint, epoch: "2" } },
      { ...page, scope: "narrowed" },
      { ...page, mode: "delta" },
      { ...page, completion: "more" },
      { ...page, completion: "more", cursor: "same" },
      {
        ...page,
        entries: [{ state: "absent", path: "A.md", proof: "native-delete" }],
      },
      {
        ...page,
        entries: [{ state: "known", path: "A.md", revision: "r".repeat(513) }],
      },
      {
        ...page,
        entries: Array.from(
          { length: 1001 },
          (_, i) => ({ state: "excluded", path: `${i}` }),
        ),
      },
      {
        ...page,
        entries: [{
          state: "unknown",
          reason: "x".repeat(DRIVER_LIMITS.metadataBytes),
        }],
      },
      {
        ...page,
        entries: [{ state: "known", path: "e\u0301.md", revision: "1" }, {
          state: "known",
          path: "\u00e9.md",
          revision: "2",
        }],
      },
      { ...page, groups: [{ id: "g", members: ["missing.md"] }] },
      { ...page, entries: [{ ...page.entries[0], group: "undeclared" }] },
    ]
  ) {
    invalid(() =>
      validateDiscoveryPage(
        value,
        caps,
        { mode: "snapshot", cursor: "same" },
        binding,
      )
    );
  }
  const deltaCaps = {
    ...caps,
    discovery: { snapshot: true as const, delta: true },
  };
  const delta: DiscoveryPage = {
    ...page,
    mode: "delta" as const,
    entries: [{ state: "absent", path: "A.md", proof: "native-delete" }],
  };
  assertEquals(
    validateDiscoveryPage(delta, deltaCaps, { mode: "delta" }, binding),
    delta,
  );
  const unknown: DiscoveryPage = {
    ...page,
    entries: [{ state: "unknown", reason: "unavailable" }, {
      state: "locked",
      path: "A.md",
      reason: "key",
    }],
  };
  assertEquals(
    validateDiscoveryPage(unknown, caps, { mode: "snapshot" }, binding),
    unknown,
  );
  for (
    const name of [
      "/A.md",
      "../A.md",
      "a//b",
      "a/./b",
      "a\\b",
      ".globnotes-staging-x",
      "\ud800",
      "a".repeat(4097),
    ]
  ) invalid(() => driverPath(name));
  assertEquals(driverPath(".obsidian/\u00e9.md"), ".obsidian/\u00e9.md");
});

Deno.test("drivers: outgoing units capture bytes and require exact complete receipts", () => {
  const captured = validateExportItems(items, caps);
  assertEquals(captured, items);
  captured[0].bytes![0] = 2;
  assertEquals(items[0].bytes![0], 1);
  assertEquals(
    validateMutationResults(
      [{ id: "1", state: "settled", revision: "native" }],
      items,
    ),
    [{ id: "1", state: "settled", revision: "native" }],
  );
  for (
    const value of [
      [],
      [{ id: "1", state: "settled" }],
      [{ id: "other", state: "uncertain" }],
      [{ id: "1", state: "conflict", revision: "untrusted" }],
      [{ id: "1", state: "failed", error: { code: "unknown" } }],
    ]
  ) invalid(() => validateMutationResults(value, items));
  for (
    const value of [
      [],
      [{ ...items[0], base: { absent: true, revision: "both" } }],
      [{ ...items[0], op: "delete" }],
      [{ ...items[0], from: "B.md" }],
      [{ ...items[0], bytes: new Uint8Array(DRIVER_LIMITS.bodyBytes + 1) }],
      Array.from({ length: 65 }, (_, i) => ({ ...items[0], id: `${i}` })),
    ]
  ) invalid(() => validateExportItems(value, caps));
});

Deno.test("drivers: failure advice is strictly typed and never decorates complete discovery or known reads", () => {
  const error = {
    code: "rate_limited" as const,
    retryAfterMs: 23000,
    message: "Wait",
  };
  const incomplete = { ...page, completion: "incomplete" as const, error };
  assertEquals(
    validateDiscoveryPage(incomplete, caps, { mode: "snapshot" }, binding),
    incomplete,
  );
  const unknown = { state: "unknown" as const, reason: "unavailable", error };
  assertEquals(validateReadResult(unknown, caps), unknown);
  for (
    const value of [
      { ...page, error },
      { ...incomplete, error: { ...error, extra: "no" } },
      { ...incomplete, error: { ...error, retryAfterMs: -1 } },
      { ...incomplete, error: { code: "provider_said_so" } },
    ]
  ) {
    invalid(() =>
      validateDiscoveryPage(value, caps, { mode: "snapshot" }, binding)
    );
  }
  for (
    const value of [
      { ...unknown, state: "locked" },
      { state: "absent", error },
      { state: "known", revision: "r", bytes: new Uint8Array(), error },
      { ...unknown, error: { ...error, peer: "someone-else" } },
      { ...unknown, error: { ...error, retryAfterMs: Infinity } },
    ]
  ) invalid(() => validateReadResult(value, caps));
});

Deno.test("drivers: transport envelopes cannot smuggle application RPCs or authority", () => {
  const rpc = {
    type: "rpc",
    generation: "generation",
    id: 1,
    contextId: "context",
    pre: false,
    method: "driver.secret",
    args: ["token"],
  };
  validateDriverEnvelope(rpc);
  validateDriverEnvelope({
    type: "heartbeat",
    generation: "generation",
    lateMs: 0,
  });
  for (
    const value of [
      { ...rpc, method: "files.read" },
      { ...rpc, args: ["other-instance", "token"] },
      { ...rpc, peer: "other" },
      { ...rpc, pre: true },
      { ...rpc, id: -1 },
      {
        type: "result",
        generation: "g",
        id: 1,
        contextId: "ctx",
        ok: "yes",
        value: {},
      },
      {
        type: "register",
        generation: "g",
        handlerId: "h",
        registration: { kind: "hook", id: "on-save" },
      },
      {
        type: "register",
        generation: "g",
        handlerId: "h",
        registration: { kind: "driver", id: "read", peer: "other" },
      },
    ]
  ) invalid(() => validateDriverEnvelope(value));
});

Deno.test("drivers: manifest accepts driver-only plugins and grants no direct vault rights", async () => {
  const fixture = await driverFixture();
  try {
    assertEquals(fixture.manifest.driver?.capabilities, caps);
    assertEquals(fixture.manifest.entry, undefined);
    const manager = createPluginManager(
      fixture.vault,
      undefined,
      1,
      fixture.statePath,
      { internalRoot: `${fixture.root}/no-built-ins` },
    );
    try {
      const plugin = (await manager.catalog()).plugins.find((plugin) =>
        plugin.id === "test-driver"
      )!;
      assertEquals(plugin.driver?.apiVersion, 1);
      assertEquals(plugin.driver?.capabilities, caps);
      assertEquals(plugin.driver?.secrets, driverDeclaration.secrets);
      assertEquals(manager.hosts.size, 0);
    } finally {
      manager.stop();
    }
    const permissions = workerPermissions(fixture.manifest, fixture.vault, {
      role: "driver",
    }) as Deno.PermissionOptionsObject;
    assertEquals(permissions.write, false);
    assertEquals(permissions.env, false);
    assertEquals(permissions.run, false);
    assertEquals((permissions.read as string[]).includes(fixture.vault), false);
    for (
      const driver of [
        { ...driverDeclaration, apiVersion: 2 },
        { ...driverDeclaration, settings: null },
        { ...driverDeclaration, extra: "no" },
        { ...driverDeclaration, entry: "../driver.js" },
        { ...driverDeclaration, secrets: [{ key: "Token", label: "Key" }] },
        {
          ...driverDeclaration,
          secrets: [{ key: "token", label: "Key" }, {
            key: "token",
            label: "Other",
          }],
        },
        {
          ...driverDeclaration,
          settings: [{
            key: "bad",
            type: "password",
            label: "Key",
            default: "",
          }],
        },
      ]
    ) {
      await Deno.writeTextFile(
        `${fixture.dir}/manifest.json`,
        JSON.stringify({ id: "test-driver", driver }),
      );
      assertThrows(() => readManifest(fixture.dir));
    }
  } finally {
    await fixture.dispose();
  }
});
