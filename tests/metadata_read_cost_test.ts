// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { MetadataProjection } from "../server/metadata/projection.ts";
import { metadataRead } from "../server/metadata/service.ts";
import type {
  MetadataPage,
  MetadataRecord,
} from "../server/metadata/contracts.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { ObservedClock } from "../server/observed_time.ts";
import { LivenessClock } from "./helpers/worker_liveness.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { queryMetadata } from "../server/metadata/query.ts";
import { metadataQuery } from "../server/metadata/contracts.ts";

Deno.test("metadata read cost: warm get and bounded queries do not rescan the vault or every directory", () => {
  const count = Number(Deno.env.get("GLOBNOTES_METADATA_COST_NOTES") ?? 128);
  assert(Number.isSafeInteger(count) && count >= 128 && count <= 20000);
  const f = hubOperationsFixture();
  for (let i = 0; i < count; i++) {
    Deno.writeTextFileSync(
      `${f.vault}/note-${String(i).padStart(5, "0")}.md`,
      "# current\n",
    );
  }
  f.hub.scanNow();
  const dir = `${f.config.statePath}/plugins/cost`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    `${dir}/manifest.json`,
    JSON.stringify({
      id: "cost",
      runtime: { server: "service.js" },
      capabilities: { read: ["vault"] },
    }),
  );
  Deno.writeTextFileSync(
    `${dir}/service.js`,
    "export function activate() {}\n",
  );
  const manifest = readManifest(dir), scheduler = new LivenessClock();
  // Pause parser scheduling: measure read ownership on an actual tracked namespace,
  // including explicit 'reading' rows, independently of cold parse throughput.
  const p = new MetadataProjection(f.hub, {
    clock: new ObservedClock(scheduler),
  });
  const nativeDir = Deno.readDirSync,
    nativeReal = Deno.realPathSync,
    nativeStat = Deno.lstatSync,
    files = f.hub.store.files.bind(f.hub.store);
  let io = {
    directories: 0,
    entries: 0,
    realpaths: 0,
    stats: 0,
    inventories: 0,
  };
  try {
    const warmStart = performance.now();
    p.records();
    const warmMs = performance.now() - warmStart;
    Deno.readDirSync = (path) => {
      io.directories++;
      return (function* () {
        for (const entry of nativeDir(path)) {
          io.entries++;
          yield entry;
        }
      })();
    };
    Deno.realPathSync = (path) => {
      io.realpaths++;
      return nativeReal(path);
    };
    Deno.lstatSync = (path) => {
      io.stats++;
      return nativeStat(path);
    };
    f.hub.store.files = () => {
      io.inventories++;
      return files();
    };
    const measure = (method: string, args: unknown) => {
      io = {
        directories: 0,
        entries: 0,
        realpaths: 0,
        stats: 0,
        inventories: 0,
      };
      const start = performance.now();
      const value = metadataRead(p, manifest, method, [args], () => true);
      return { value, ms: performance.now() - start, io: { ...io } };
    };
    const name = `note-${String(count - 1).padStart(5, "0")}.md`;
    const get = measure("metadata.get", name),
      narrow = measure("metadata.query", { prefix: name, limit: 3 }),
      page = measure("metadata.query", { limit: 3 });
    assertEquals((get.value as MetadataRecord).path, name);
    assertEquals((narrow.value as MetadataPage).total, 1);
    assertEquals((page.value as MetadataPage).total, count);
    assertEquals((page.value as MetadataPage).unavailable.length, 3);
    const observations = {
      notes: count,
      parser: "paused",
      warmMs,
      get: { ms: get.ms, ...get.io },
      narrow: { ms: narrow.ms, ...narrow.io },
      page: { ms: page.ms, ...page.io },
    };
    console.log(JSON.stringify({ metadataReadCost: observations }));
    let classified = 0;
    queryMetadata(p, metadataQuery({ prefix: name }), () => {
      classified++;
      return true;
    });
    assertEquals(classified, 1, "a narrow prefix classified the entire vault");
    for (const result of [get, narrow, page]) {
      assertEquals(
        result.io.inventories,
        0,
        "read rebuilt the full hub inventory",
      );
      assertEquals(
        result.io.directories,
        0,
        "read rescanned directory entries after the projection snapshot",
      );
      assert(
        result.io.realpaths <= 64,
        "read canonicalized more paths than its bounded result",
      );
      assert(
        result.io.stats <= 16,
        "read statted more routes than its bounded result",
      );
    }
  } finally {
    Deno.readDirSync = nativeDir;
    Deno.realPathSync = nativeReal;
    Deno.lstatSync = nativeStat;
    f.hub.store.files = files;
    p.stop();
    f.close();
  }
});

Deno.test("metadata read cost: a newly unsafe directory cannot turn one page into a vault-wide disclosure scan", () => {
  const f = hubOperationsFixture();
  Deno.mkdirSync(`${f.vault}/notes`);
  for (let i = 0; i < 128; i++) {
    Deno.writeTextFileSync(`${f.vault}/notes/${i}.md`, "# note");
  }
  f.hub.scanNow();
  const p = new MetadataProjection(f.hub, {
    clock: new ObservedClock(new LivenessClock()),
  });
  const native = Deno.lstatSync;
  let stats = 0;
  try {
    p.records();
    Deno.renameSync(`${f.vault}/notes`, `${f.vault}/kept`);
    Deno.symlinkSync(f.config.statePath, `${f.vault}/notes`);
    Deno.lstatSync = (path) => {
      stats++;
      return native(path);
    };
    const page = queryMetadata(p, metadataQuery({ limit: 3 }), () => true);
    assertEquals(page.rows, []);
    assertEquals(page.unavailable, []);
    assert(
      stats <= 3,
      "unsafe candidates escaped the requested disclosure window",
    );
  } finally {
    Deno.lstatSync = native;
    p.stop();
    f.close();
  }
});
