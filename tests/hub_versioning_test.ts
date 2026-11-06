// SPDX-License-Identifier: LGPL-3.0-only

/** The versioning extension point (docs/hub.md "Versioning"): bytes about to
 * be replaced, deleted or moved away are offered to versioning plugins before
 * the write; creates are not offered; a versioner's own writes are never
 * offered and cannot deadlock; failures let the write proceed visibly. */

import { assert, assertEquals } from "@std/assert";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { fixtureApiOrigin } from "./helpers/plugin_fixture.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";

const VERSIONER = `
let mode = "keep";
const seen = [];
export function activate(ctx) {
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
    if (mode === "slow") await new Promise((r) => setTimeout(r, 3000));
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
    files: { "service.js": VERSIONER },
    limits,
  });
  const facts: OperationFact[] = [];
  b.lifecycle.onFact((fact) => facts.push(fact));
  return {
    ...b,
    facts,
    seen: () => b.command("run", {}) as Promise<Record<string, unknown>[]>,
    mode: (mode: string) => b.command("run", { mode }),
    origin: () => fixtureApiOrigin(b.lifecycle),
  };
}

Deno.test("versioning: a save offers the replaced bytes while they are still on disk", async () => {
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
      disk: "first",
      origin: "api",
      size: 5,
    }]);
    const save = v.facts.find((f) => f.action === "save")!;
    assertEquals(save.metadata?.versioning, [{
      pluginId: "versioner",
      path: "Note.md",
      status: "kept",
    }]);
    await v.remove("Note");
    assertEquals((await v.seen()).map((s) => [s.kind, s.text, s.disk]), [[
      "delete",
      "second",
      "second",
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
      { newPath: "b/Note" },
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
    );
    assertEquals(await v.seen(), [], ".bin is not declared");
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

Deno.test("versioning: a failing, declining or slow versioner never blocks the write", async () => {
  const v = await versionerFixture({}, { versioningMs: 500 });
  try {
    await v.create("Note", "v1");
    for (
      const [mode, status] of [["fail", "failed"], ["decline", "declined"]]
    ) {
      await v.mode(mode);
      v.facts.length = 0;
      const saved = await v.save("Note", `after-${mode}`);
      assertEquals(saved.content, `after-${mode}`);
      assertEquals(
        v.facts.find((f) => f.action === "save")!.metadata?.versioning,
        [{ pluginId: "versioner", path: "Note.md", status }],
      );
    }
    const failed = v.runtime.status("versioner")!;
    assert(
      failed.diagnostics.some((d) => d.code === "versioning_failed"),
      "a failure is visible",
    );
    await v.mode("slow");
    v.facts.length = 0;
    const slow = await v.save("Note", "after-slow");
    assertEquals(slow.content, "after-slow");
    assertEquals(
      Deno.readTextFileSync(`${v.fixture.vault}/Note.md`),
      "after-slow",
    );
    assertEquals(
      v.facts.find((f) => f.action === "save")!.metadata?.versioning,
      [{ pluginId: "versioner", path: "Note.md", status: "timeout" }],
    );
  } finally {
    await v.close();
  }
});

Deno.test("versioning: offers carry the writer's origin and leave the file as it was", async () => {
  const v = await versionerFixture({
    capabilities: {
      network: false,
      imports: false,
      read: ["vault"],
      write: [],
      filesystem: { read: ["vault"], write: ["vault"] },
    },
  });
  // A second, non-versioning plugin writes through the facade.
  try {
    Deno.writeTextFileSync(`${v.fixture.vault}/data.bin`, "before");
    v.hub.scanNow();
    const before = v.hub.fileState("data.bin")!;
    const outcomes = await v.gate.offer(
      [{ kind: "replace", file: `${v.fixture.vault}/data.bin` }],
      "plugin:writer",
      "op-1",
      Number.MAX_SAFE_INTEGER,
    );
    assertEquals(outcomes, [{
      versioner: "versioner",
      path: "data.bin",
      status: "kept",
    }]);
    const [offer] = await v.seen();
    assertEquals([offer.kind, offer.text, offer.origin], [
      "replace",
      "before",
      "plugin:writer",
    ]);
    assertEquals(v.hub.fileState("data.bin")!.hash, before.hash);
  } finally {
    await v.close();
  }
});
