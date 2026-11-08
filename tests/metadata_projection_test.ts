// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { MetadataProjection } from "../server/metadata/projection.ts";
import { parseMetadata } from "../server/metadata/parse.ts";
import { getMetadata, queryMetadata } from "../server/metadata/query.ts";
import { metadataQuery } from "../server/metadata/contracts.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { ObservedClock } from "../server/observed_time.ts";
import { LivenessClock } from "./helpers/worker_liveness.ts";

function caught(projection: MetadataProjection) {
  return waitUntil(
    () =>
      !projection.catchingUp
        ? done()
        : pending({ cursor: projection.cursor, records: projection.records() }),
    { label: "current metadata projection" },
  );
}
Deno.test("metadata projection: synchronous invalidation and late parse cannot repopulate deleted/renamed current records", async () => {
  const f = hubOperationsFixture();
  Deno.writeTextFileSync(`${f.vault}/old.md`, "# Old\nkey:: secret");
  f.hub.scanNow();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const p = new MetadataProjection(f.hub, {
    parse: async (text) => {
      entered.resolve();
      await release.promise;
      return parseMetadata(text);
    },
  });
  try {
    await entered.promise;
    Deno.renameSync(`${f.vault}/old.md`, `${f.vault}/new.md`);
    f.hub.scanNow();
    assert(!JSON.stringify(p.records()).includes("secret"));
    release.resolve();
    await caught(p);
    assertEquals(p.records().map((r) => r.path), ["new.md"]);
    Deno.removeSync(`${f.vault}/new.md`);
    f.hub.scanNow();
    assertEquals(p.records(), []);
    await caught(p);
  } finally {
    release.resolve();
    p.stop();
    f.close();
  }
});
Deno.test("metadata projection: read/UTF8/size/parser failures are explicit and groups publish together", async () => {
  const f = hubOperationsFixture();
  for (const name of ["good", "read", "utf8", "parse", "large"]) {
    Deno.writeTextFileSync(`${f.vault}/${name}.md`, name);
  }
  Deno.writeFileSync(`${f.vault}/utf8.md`, new Uint8Array([255]));
  Deno.writeFileSync(
    `${f.vault}/large.md`,
    new Uint8Array(16 * 1024 * 1024 + 1),
  );
  f.hub.scanNow();
  const p = new MetadataProjection(f.hub, {
    read: (path) =>
      path.endsWith("read.md")
        ? Promise.reject(new Deno.errors.PermissionDenied())
        : Deno.readFile(path),
    parse: (text) => {
      if (text === "parse") throw new Error("parser fault");
      return parseMetadata(text);
    },
  });
  try {
    await caught(p);
    assertEquals(
      p.records().map(
        (r) => [r.path, r.status === "unavailable" ? r.reason : r.status],
      ).sort(),
      [
        ["good.md", "ready"],
        ["large.md", "too_large"],
        ["parse.md", "parse_failed"],
        ["read.md", "read_failed"],
        ["utf8.md", "invalid_utf8"],
      ],
    );
    const observations: string[][] = [];
    p.subscribe(() =>
      observations.push(
        p.records().filter((r) => r.status === "ready").map((r) => r.path)
          .sort(),
      )
    );
    const token = f.hub.expect([`${f.vault}/a.md`, `${f.vault}/b.md`]);
    Deno.writeTextFileSync(`${f.vault}/a.md`, "a");
    Deno.writeTextFileSync(`${f.vault}/b.md`, "b");
    f.hub.record(token, [{ kind: "write", path: `${f.vault}/a.md` }, {
      kind: "write",
      path: `${f.vault}/b.md`,
    }], "api");
    await caught(p);
    assert(
      !observations.some((rows) =>
        rows.includes("a.md") !== rows.includes("b.md")
      ),
    );
  } finally {
    p.stop();
    f.close();
  }
});
Deno.test("metadata query: eligibility before filters/counts, segment prefix, equality/task AND and bounded windows", async () => {
  const f = hubOperationsFixture();
  Deno.mkdirSync(`${f.vault}/scope`);
  Deno.mkdirSync(`${f.vault}/scope-other`);
  for (
    const [path, body] of [
      ["scope/a.md", "---\ntags: [yes, no]\n---\n- [x] done"],
      ["scope/b.md", "---\ntags: no\n---\n- [ ] pending"],
      ["scope-other/c.md", "hidden"],
      ["private.md", "hidden"],
    ]
  ) Deno.writeTextFileSync(`${f.vault}/${path}`, body);
  f.hub.scanNow();
  const p = new MetadataProjection(f.hub);
  try {
    await caught(p);
    const q = metadataQuery({
      prefix: "scope",
      property: { key: "tags", equals: "yes" },
      task: { checked: true },
    });
    const page = queryMetadata(p, q, (path) => path.startsWith("scope/"));
    assertEquals(page.total, 1);
    assertEquals(page.rows.map((r) => r.path), ["scope/a.md"]);
    const first = queryMetadata(
      p,
      metadataQuery({ limit: 1 }),
      (path) => path.startsWith("scope/"),
    );
    assertEquals(first.total, 2);
    assertEquals(first.nextOffset, 1);
    assertEquals(
      queryMetadata(
        p,
        metadataQuery({ offset: 1, limit: 1 }),
        (path) => path.startsWith("scope/"),
      ).rows.map((r) => r.path),
      ["scope/b.md"],
    );
  } finally {
    p.stop();
    f.close();
  }
});

Deno.test("metadata projection: pruned-log recovery rebuilds and snapshot pages have no partially ready publication", async () => {
  const f = hubOperationsFixture({}, { changeLimit: 3 });
  const scheduler = new LivenessClock(), clock = new ObservedClock(scheduler);
  const p = new MetadataProjection(f.hub, {
    clock,
    read: (path) => Promise.resolve(Deno.readFileSync(path)),
  });
  const drain = () =>
    waitUntil(async () => {
      scheduler.tick(scheduler.time + 1, true);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return !p.catchingUp ? done() : pending(p.cursor);
    }, { label: "observed-clock metadata recovery" });
  try {
    await drain();
    const revision = p.revision;
    for (let i = 0; i < 6; i++) {
      Deno.writeTextFileSync(`${f.vault}/note.md`, `# revision ${i}`);
      f.hub.scanNow();
    }
    await drain();
    const row = p.records()[0];
    assert(row.status === "ready");
    assertEquals(row.headings[0].text, "revision 5");
    assert(p.revision !== revision);
    // Retention forces a fresh snapshot; pages stay staged until completion.
    const paths = Array.from(
      { length: 130 },
      (_, i) => `${f.vault}/group-${String(i).padStart(3, "0")}.md`,
    );
    const token = f.hub.expect(paths);
    for (const path of paths) Deno.writeTextFileSync(path, "# grouped");
    const sizes: number[] = [];
    p.subscribe(() =>
      sizes.push(
        p.records().filter((r) =>
          r.status === "ready" && r.path.startsWith("group-")
        ).length,
      )
    );
    f.hub.record(
      token,
      paths.map((path) => ({ kind: "write" as const, path })),
      "api",
    );
    await drain();
    assertEquals(p.records().filter((r) => r.status === "ready").length, 131);
    assert(sizes.every((size) => size === 0 || size === 130));
    assertEquals(f.hub.store.pluginCursorOwners(), []);
  } finally {
    p.stop();
    f.close();
  }
});

Deno.test("metadata projection: multipart replay publishes the entire group after its tail", async () => {
  const f = hubOperationsFixture();
  const p = new MetadataProjection(f.hub);
  try {
    await caught(p);
    const paths = Array.from(
      { length: 130 },
      (_, i) => `${f.vault}/group-${String(i).padStart(3, "0")}.md`,
    );
    const token = f.hub.expect(paths);
    for (const path of paths) Deno.writeTextFileSync(path, "# group");
    const observations: number[] = [];
    p.subscribe(() =>
      observations.push(p.records().filter((r) => r.status === "ready").length)
    );
    f.hub.record(
      token,
      paths.map((path) => ({ kind: "write" as const, path })),
      "api",
    );
    await caught(p);
    assertEquals(p.records().length, 130);
    assert(observations.every((n) => n === 0 || n === 130));
  } finally {
    p.stop();
    f.close();
  }
});

Deno.test("metadata projection: changed bytes during planned read re-plan instead of labelling today's bytes as an old version", async () => {
  const f = hubOperationsFixture();
  Deno.writeTextFileSync(`${f.vault}/note.md`, "# old");
  f.hub.scanNow();
  let changed = false;
  const scheduler = new LivenessClock(), clock = new ObservedClock(scheduler);
  const p = new MetadataProjection(f.hub, {
    clock,
    read: (path) => {
      if (!changed) {
        changed = true;
        Deno.writeTextFileSync(path, "# newer body");
      }
      return Promise.resolve(Deno.readFileSync(path));
    },
  });
  try {
    await waitUntil(async () => {
      scheduler.tick(scheduler.time + 250, true);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return !p.catchingUp
        ? done()
        : pending({ cursor: p.cursor, records: p.records() });
    }, { label: "re-planned current bytes" });
    const row = p.records()[0];
    assert(row.status === "ready");
    assertEquals(row.headings[0].text, "newer body");
    assertEquals(row.version, f.hub.fileState("note.md")!.hash);
  } finally {
    p.stop();
    f.close();
  }
});

Deno.test("metadata projection: cached catalogue rechecks disclosed links and replaces namespace/collision observations on publication", async () => {
  const f = hubOperationsFixture();
  Deno.mkdirSync(`${f.vault}/notes`);
  Deno.writeTextFileSync(`${f.vault}/notes/visible.md`, "# visible");
  f.hub.scanNow();
  const p = new MetadataProjection(f.hub);
  try {
    await caught(p);
    assertEquals(p.records().length, 1);
    const before = p.revision;
    Deno.renameSync(`${f.vault}/notes`, `${f.vault}/kept`);
    Deno.symlinkSync(f.config.statePath, `${f.vault}/notes`);
    assertEquals(getMetadata(p, "notes/visible.md"), null);
    assertEquals(queryMetadata(p, metadataQuery({}), () => true).total, 0);
    assert(p.revision !== before);
    Deno.removeSync(`${f.vault}/notes`);
    Deno.renameSync(`${f.vault}/kept`, `${f.vault}/notes`);
    assert(getMetadata(p, "notes/visible.md"));
    Deno.writeTextFileSync(`${f.vault}/\u00e9.md`, "# first");
    f.hub.scanNow();
    await caught(p);
    assert(getMetadata(p, "\u00e9.md"));
    Deno.writeTextFileSync(`${f.vault}/e\u0301.md`, "# collision");
    Deno.writeTextFileSync(
      `${f.vault}/notes/visible.md`,
      "# changed publication",
    );
    f.hub.scanNow();
    await caught(p);
    assertEquals(getMetadata(p, "\u00e9.md"), null);
    assertEquals(p.records().map((row) => row.path), ["notes/visible.md"]);
    Deno.removeSync(`${f.vault}/e\u0301.md`);
    Deno.removeSync(`${f.vault}/\u00e9.md`);
    f.hub.scanNow();
    assert(!JSON.stringify(p.records()).includes("first"));
  } finally {
    p.stop();
    f.close();
  }
});
