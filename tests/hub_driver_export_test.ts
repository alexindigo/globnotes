// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { exportUnits, planExport } from "../server/hub/drivers/exporter.ts";
import type { PeerFile } from "../server/hub/drivers/peers.ts";
const file = {
  key: "a.md",
  diskPath: "a.md",
  hash: "current",
  size: 1,
  mtimeMs: 0,
  vector: { local: 1 },
  seq: 3,
};
const mapping: PeerFile = {
  pathKey: "anonymous",
  version: "old",
  revision: "native-r1",
  state: "synced",
  attempts: 0,
  nextAt: 0,
};
Deno.test("driver export: compare state, preserve conditions, wait for anonymous deletion names", () => {
  const input = { pathKey: "anonymous", file, mapping, batch: 3, now: 10 };
  const change = planExport(input);
  assertEquals(change, {
    kind: "send",
    item: {
      pathKey: "anonymous",
      path: "a.md",
      op: "put",
      version: "current",
      batch: 3,
      base: { revision: "native-r1" },
    },
  });
  assertEquals(
    planExport({ ...input, mapping: { ...mapping, version: "current" } }).kind,
    "none",
  );
  assertEquals(planExport({ ...input, mapping: null }), {
    kind: "send",
    item: {
      pathKey: "anonymous",
      path: "a.md",
      op: "put",
      version: "current",
      batch: 3,
      base: { absent: true },
    },
  });
  assertEquals(planExport({ ...input, file: null }).kind, "delete-pending");
  assertEquals(planExport({ ...input, file: null, path: "a.md" }), {
    kind: "send",
    item: {
      pathKey: "anonymous",
      path: "a.md",
      op: "delete",
      version: null,
      batch: 3,
      base: { revision: "native-r1" },
    },
  });
  assertEquals(
    planExport({ ...input, file: { ...file, size: 17 * 1024 * 1024 } }).kind,
    "too_large",
  );
  for (
    const state of ["held", "excluded", "unsupported", "uncertain"] as const
  ) {
    assertEquals(
      planExport({ ...input, mapping: { ...mapping, state } }).kind,
      "none",
    );
  }
  assertEquals(
    planExport({ ...input, mapping: { ...mapping, nextAt: 11 } }).kind,
    "none",
  );
});
Deno.test("driver export: whole hub batches fit together and put precedes emulated delete", () => {
  const items = Array.from(
    { length: 13 },
    (_, n) => ({
      pathKey: `key${n}`,
      path: `file${n}`,
      op: "put" as const,
      version: "hash",
      batch: 1,
      base: { absent: true as const },
    }),
  );
  assertEquals(exportUnits(items, 64).map((unit) => unit.length), [13]);
  assertEquals(
    exportUnits([...items, ...items.map((item) => ({ ...item, batch: 2 }))], 16)
      .map((unit) => unit.length),
    [13, 13],
  );
  const moved = exportUnits([{ ...items[0], op: "delete" }, items[1]], 64);
  assertEquals(moved[0].map((item) => item.op), ["put", "delete"]);
});
