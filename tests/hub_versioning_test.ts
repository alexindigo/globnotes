// SPDX-License-Identifier: LGPL-3.0-only

/** Legacy versioning: post-commit best-effort bytes, bounded delivery and no
 * plugin completion dependency on any writer. */

import { currentBase } from "./helpers/storage.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { fixtureApiOrigin } from "./helpers/plugin_fixture.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";
import { versionOf } from "../server/hub/merge.ts";
import { VaultEffects } from "../server/hub/effects.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

const VERSIONER = `
let mode = "keep", slowMs = 3000, guardMs = 0, finished = 0, release;
const seen = [];
export function activate(ctx) {
  if (GUARD) ctx.hooks.on("pre-save", () => new Promise((r) => setTimeout(r, guardMs)));
  ctx.versioning.onOffer(async (offer) => {
    let disk;
    try {
      disk = new TextDecoder().decode(await ctx.fs.readFile(offer.path));
    } catch (error) {
      disk = "error:" + (error.code ?? error.message);
    }
    seen.push({
      kind: offer.kind,
      path: offer.path,
      newPath: offer.newPath ?? null,
      text: offer.bytes ? new TextDecoder().decode(offer.bytes) : null,
      disk,
      origin: offer.origin,
      size: offer.size,
    });
    if (mode === "fail") throw new Error("versioner failed");
    if (mode === "slow") await new Promise((r) => setTimeout(r, slowMs));
    if (mode === "hang") await new Promise(() => {});
    if (mode === "hold") await new Promise((r) => { release = r; });
    finished++;
    if (mode === "decline") return { status: "declined" };
    if (mode === "store") {
      // Its own in-vault write from inside the handler: never offered.
      await ctx.fs.writeFile("version-" + seen.length + ".txt", offer.bytes, {
        expect: { kind: "absent" },
      });
    }
  });
  ctx.commands.register({ id: "run", label: "run", target: "server" }, (p) => {
    if (p.mode) mode = p.mode;
    if (p.slowMs) slowMs = p.slowMs;
    if (p.guardMs) guardMs = p.guardMs;
    if (p.finished) return finished;
    if (p.count) return seen.length;
    if (p.release) { mode = "keep"; release?.(); return; }
    if (p.write) {
      return ctx.fs.writeFile(p.write, new TextEncoder().encode("own"), {
        expect: { kind: "absent" },
      }).then(() => "written");
    }
    return seen.splice(0);
  });
}
`;

async function versionerFixture(
  manifest: Record<string, unknown> = {},
  limits = {},
) {
  const b = await pluginOperationsFixture({
    id: "versioner",
    manifest: {
      runtime: { server: "service.js" },
      versioning: { extensions: [".md", ".bin"] },
      capabilities: {
        network: false,
        imports: false,
        read: ["vault"],
        write: [],
        filesystem: { read: ["vault"], write: ["vault"] },
      },
      ...manifest,
    },
    files: {
      "service.js": `const GUARD = ${
        JSON.stringify(
          (manifest.hooks as string[] | undefined)?.includes(
            "pre-save",
          ) ?? false,
        )
      };\n${VERSIONER}`,
    },
    limits,
  });
  const facts: OperationFact[] = [];
  b.lifecycle.onFact((fact) => facts.push(fact));
  const idle = (id = "versioner") =>
    waitUntil(() => {
      const status = b.runtime.status(id);
      return status?.versioningPending === 0 ? done() : pending(status);
    }, { label: `versioning delivery idle: ${id}` });
  return {
    ...b,
    facts,
    idle,
    seen: async () => {
      await idle();
      return await b.command("run", {}) as Record<string, unknown>[];
    },
    mode: (mode: string) => b.command("run", { mode }),
    origin: () => fixtureApiOrigin(b.lifecycle),
  };
}

Deno.test("versioning: delivery sees the committed disk and carries the displaced bytes", async () => {
  const v = await versionerFixture();
  try {
    await v.create("Note", "first");
    assertEquals(await v.seen(), [], "a create displaces nothing");
    const saved = await v.save("Note", "second");
    assertEquals(saved.content, "second");
    assertEquals(await v.seen(), [{
      kind: "replace",
      path: "Note.md",
      newPath: null,
      text: "first",
      disk: "second",
      origin: "api",
      size: 5,
    }]);
    const save = v.facts.find((f) => f.action === "save")!;
    assertEquals(
      save.metadata?.versioning,
      undefined,
      "save facts cannot report asynchronous outcomes",
    );
    await v.remove("Note");
    assertEquals((await v.seen()).map((s) => [s.kind, s.text, s.disk]), [[
      "delete",
      "second",
      "error:fs_not_found",
    ]]);
  } finally {
    await v.close();
  }
});

Deno.test("versioning: renames offer the bytes leaving the old path, attachments too", async () => {
  const v = await versionerFixture();
  try {
    Deno.mkdirSync(`${v.fixture.vault}/a`);
    Deno.writeTextFileSync(`${v.fixture.vault}/a/pic.bin`, "binary");
    await v.create("a/Note", "![](pic.bin)");
    await v.operations.updateNote(
      "a/Note",
      { base: currentBase("a/Note"), newPath: "b/Note" },
      "move",
      v.origin(),
    );
    const seen = await v.seen();
    assertEquals(
      seen.map((s) => [s.kind, s.path, s.newPath, s.text]).sort(),
      [
        ["move", "a/Note.md", "b/Note.md", "![](pic.bin)"],
        ["move", "a/pic.bin", "b/pic.bin", "binary"],
      ],
    );
  } finally {
    await v.close();
  }
});

Deno.test("versioning: extensions and read grants decide what a versioner sees", async () => {
  const v = await versionerFixture({ versioning: { extensions: [".md"] } });
  try {
    Deno.writeTextFileSync(`${v.fixture.vault}/x.bin`, "old");
    await v.operations.writeExternalFile(
      { kind: "file", absolutePath: `${v.fixture.vault}/x.bin` },
      new TextEncoder().encode("new"),
      v.origin(),
      undefined,
      undefined,
      {
        kind: "version",
        version: versionOf(Deno.readFileSync(`${v.fixture.vault}/x.bin`)),
      },
    );
    assertEquals(await v.seen(), [], ".bin is not declared");
  } finally {
    await v.close();
  }
});

Deno.test("versioning: facade replace, overwrite-move and removal deliver only after commit", async () => {
  const v = await versionerFixture();
  try {
    await v.fixture.install("writer", {
      runtime: { server: "service.js" },
      capabilities: { filesystem: { read: ["vault"], write: ["vault"] } },
    }, {
      "service.js": `
      export function activate(ctx) {
        ctx.commands.register({id:"write",label:"write",target:"server"}, async ({op}) => {
          const source = await ctx.fs.stat("source.bin");
          if (op === "replace") return ctx.fs.writeFile("source.bin", new TextEncoder().encode("new"), {expect:{kind:"exact",token:source.token}});
          if (op === "move") {
            const destination = await ctx.fs.stat("target.bin");
            return ctx.fs.rename("source.bin", "target.bin", {sourceToken:source.token,destination:{kind:"exact",token:destination.token}});
          }
          const target = await ctx.fs.stat("target.bin");
          return ctx.fs.remove("target.bin", {token:target.token});
        });
      }`,
    });
    await v.runtime.reconcile();
    await waitUntil(
      () =>
        v.runtime.status("writer")?.status === "ready"
          ? done()
          : pending(v.runtime.status("writer")),
      { label: "facade writer ready" },
    );
    Deno.writeTextFileSync(`${v.fixture.vault}/source.bin`, "old");
    Deno.writeTextFileSync(`${v.fixture.vault}/target.bin`, "target");
    await v.runtime.invokeCommand("writer", "write", { op: "replace" });
    assertEquals(
      (await v.seen()).map((s) => [s.kind, s.text, s.disk, s.origin]),
      [
        ["replace", "old", "new", "plugin:writer"],
      ],
    );
    await v.runtime.invokeCommand("writer", "write", { op: "move" });
    assertEquals(
      (await v.seen()).map((s) => [s.kind, s.path, s.text, s.disk]),
      [
        ["move", "source.bin", "new", "error:fs_not_found"],
        ["replace", "target.bin", "target", "new"],
      ],
    );
    await v.runtime.invokeCommand("writer", "write", { op: "remove" });
    assertEquals((await v.seen()).map((s) => [s.kind, s.text, s.disk]), [
      ["delete", "new", "error:fs_not_found"],
    ]);
  } finally {
    await v.close();
  }
});

Deno.test("versioning: a versioner's own writes are never offered and never deadlock", async () => {
  const v = await versionerFixture();
  try {
    await v.mode("store");
    await v.create("Note", "one");
    await v.save("Note", "two");
    const seen = await v.seen();
    assertEquals(seen.map((s) => [s.kind, s.path]), [["replace", "Note.md"]]);
    assertEquals(
      Deno.readTextFileSync(`${v.fixture.vault}/version-1.txt`),
      "one",
    );
    // Its own replace of a file it wrote is not offered to it either.
    assertEquals(await v.command("run", { write: "own.bin" }), "written");
    assertEquals(await v.seen(), []);
    const log = v.hub.changesSince(0).entries;
    assert(
      log.some((e) =>
        e.path === "version-1.txt" && e.origin === "plugin:versioner"
      ),
      "its writes are recorded as the plugin's",
    );
  } finally {
    await v.close();
  }
});

Deno.test("versioning: failures, declines and ordinary call deadlines are plugin-local", async () => {
  const v = await versionerFixture({}, { serviceCallMs: 700 });
  try {
    await v.create("Note", "v1");
    for (const mode of ["fail", "decline"]) {
      await v.mode(mode);
      v.facts.length = 0;
      const saved = await v.save("Note", `after-${mode}`);
      assertEquals(saved.content, `after-${mode}`);
      await v.idle();
      assertEquals(v.runtime.status("versioner")!.status, "ready");
    }
    const failed = v.runtime.status("versioner")!;
    assert(
      failed.diagnostics.some((d) => d.code === "versioning_failed"),
      "a failure is visible",
    );
    await v.mode("hang");
    v.facts.length = 0;
    const slow = await v.save("Note", "after-slow");
    assertEquals(
      v.runtime.status("versioner")!.status,
      "ready",
      "save returns before the handler deadline",
    );
    assertEquals(slow.content, "after-slow");
    assertEquals(
      Deno.readTextFileSync(`${v.fixture.vault}/Note.md`),
      "after-slow",
    );
    await waitUntil(() => {
      const status = v.runtime.status("versioner");
      return status?.status === "failed" ? done() : pending(status);
    }, { label: "hung versioner ordinary deadline" });
    await v.save("Note", "after-crash");
    assertEquals(
      Deno.readTextFileSync(`${v.fixture.vault}/Note.md`),
      "after-crash",
    );
    assert(
      v.runtime.status("versioner")!.diagnostics.some((d) =>
        d.code === "versioning_gap"
      ),
    );
  } finally {
    await v.close();
  }
});

Deno.test("versioning: refused effects deliver nothing; partial commits deliver only completed effects", async () => {
  const v = await versionerFixture({
    capabilities: {
      network: false,
      imports: false,
      read: ["vault"],
      write: [],
      filesystem: { read: ["vault"], write: ["vault"] },
    },
  });
  // Drive the same effects boundary used by facade writes.
  try {
    Deno.writeTextFileSync(`${v.fixture.vault}/data.bin`, "before");
    v.hub.scanNow();
    const file = `${v.fixture.vault}/data.bin`,
      effects = new VaultEffects(v.fixture.vault);
    assertThrows(() =>
      v.gate.apply([file], "plugin:writer", [], () => {
        throw new Error("refused");
      })
    );
    assertEquals(await v.seen(), []);
    assertThrows(() =>
      v.gate.apply([file], "plugin:writer", [], () => {
        effects.replace(file, "after");
        throw new Error("later effect failed");
      }, "op-1")
    );
    const [offer] = await v.seen();
    assertEquals([offer.kind, offer.text, offer.origin], [
      "replace",
      "before",
      "plugin:writer",
    ]);
    assertEquals(offer.disk, "after");
    assertEquals(
      v.hub.fileState("data.bin")!.hash,
      versionOf(new TextEncoder().encode("after")),
    );
  } finally {
    await v.close();
  }
});

for (
  const [bound, limits] of [
    ["entries", { versioningQueue: 2 }],
    ["bytes", { versioningQueue: 8, versioningQueueBytes: 4 }],
  ] as const
) {
  Deno.test(`versioning: ${bound} overflow drops oldest pending entries with a visible gap, isolating consumers`, async () => {
    const v = await versionerFixture({}, limits);
    try {
      await v.fixture.install("healthy", {
        runtime: { server: "service.js" },
        versioning: {},
        capabilities: {
          read: ["vault"],
          filesystem: { read: ["vault"], write: [] },
        },
      }, { "service.js": `const GUARD = false;\n${VERSIONER}` });
      await v.runtime.reconcile();
      await waitUntil(
        () =>
          v.runtime.status("healthy")?.status === "ready"
            ? done()
            : pending(v.runtime.status("healthy")),
        { label: "healthy versioner ready" },
      );
      await v.mode("hold");
      await v.create("Queue", "v0");
      await v.save("Queue", "v1");
      await waitUntil(async () => {
        const count = await v.command("run", { count: true });
        return count === 1 ? done() : pending(count);
      }, { label: "first offer held" });
      for (let i = 2; i <= 5; i++) {
        await v.save("Queue", `v${i}`);
        await v.idle("healthy");
      }
      const status = v.runtime.status("versioner")!;
      assertEquals(
        status.versioningPending,
        3,
        "one active plus two pending bodies",
      );
      assertEquals(status.deliveryFailures, 2);
      assertEquals(status.degraded, true);
      assertEquals(
        status.diagnostics.filter((d) => d.code === "versioning_gap").length,
        2,
      );
      assertEquals(v.runtime.status("healthy")!.degraded, false);
      const healthy = await v.runtime.invokeCommand(
        "healthy",
        "run",
        {},
      ) as Record<string, unknown>[];
      assertEquals(healthy.map((s) => s.text), ["v0", "v1", "v2", "v3", "v4"]);
      await v.command("run", { release: true });
      assertEquals((await v.seen()).map((s) => s.text), ["v0", "v3", "v4"]);
      assertEquals(Deno.readTextFileSync(`${v.fixture.vault}/Queue.md`), "v5");
    } finally {
      await v.close();
    }
  });
}

Deno.test("versioning: guards finish before commit, not before plugin work finishes", async () => {
  const v = await versionerFixture(
    { hooks: ["pre-save"] },
    { preOperationMs: 700 },
  );
  try {
    await v.create("Note", "v1");
    await v.command("run", { mode: "hold", guardMs: 500 });
    v.facts.length = 0;
    await v.save("Note", "v2");
    assertEquals(Deno.readTextFileSync(`${v.fixture.vault}/Note.md`), "v2");
    await waitUntil(async () => {
      const count = await v.command("run", { count: true });
      return count === 1 ? done() : pending(count);
    }, { label: "post-guard versioner started" });
    await v.command("run", { release: true });
    assertEquals((await v.seen())[0].disk, "v2");
  } finally {
    await v.close();
  }
});

Deno.test("versioning: a moved attachment directory offers its files, never itself", async () => {
  const v = await versionerFixture({ versioning: {} });
  try {
    Deno.mkdirSync(`${v.fixture.vault}/a/assets/deep`, { recursive: true });
    Deno.mkdirSync(`${v.fixture.vault}/b`);
    Deno.writeTextFileSync(`${v.fixture.vault}/a/assets/one.bin`, "one");
    Deno.writeTextFileSync(`${v.fixture.vault}/a/assets/deep/two.bin`, "two");
    Deno.symlinkSync("one.bin", `${v.fixture.vault}/a/assets/link.bin`);
    await v.create("a/Note", "[files](assets)");
    await v.seen();
    const moved = await v.operations.updateNote(
      "a/Note",
      { newPath: "b/Note", base: currentBase("a/Note") },
      "move",
      v.origin(),
    );
    assertEquals(moved.path, "b/Note");
    assertEquals(
      (await v.seen()).map((s) => [s.kind, s.path, s.newPath, s.text]).sort(),
      [
        ["move", "a/Note.md", "b/Note.md", "[files](assets)"],
        ["move", "a/assets/deep/two.bin", "b/assets/deep/two.bin", "two"],
        ["move", "a/assets/one.bin", "b/assets/one.bin", "one"],
      ],
    );
    assertEquals(
      Deno.readTextFileSync(`${v.fixture.vault}/b/assets/deep/two.bin`),
      "two",
    );
  } finally {
    await v.close();
  }
});
