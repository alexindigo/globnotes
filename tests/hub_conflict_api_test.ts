import { testMetadata } from "./helpers/environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import list from "../server/api/endpoints/_/api/conflicts/get.ts";
import detail from "../server/api/endpoints/_/api/conflicts/%23id/get.ts";
import { listConflicts, readConflict } from "../server/hub/conflicts.ts";
import { versionOf } from "../server/hub/merge.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { VaultHub } from "../server/hub/hub.ts";
import { bootServer } from "./helpers/boot.ts";

function pair(
  f: ReturnType<typeof hubOperationsFixture>,
  id: string,
  original: string,
  copy: string,
) {
  f.hub.recordConflict({
    id,
    path: original,
    copyPath: copy,
    peer: "globnotes",
    reason: "stale-base",
    state: "open",
    createdAt: "2026-11-07T00:00:00Z",
    resolvedAt: null,
  });
}
const request = (
  id: string,
) => ({ params: { id } } as unknown as PathfinderRequest<{ id: string }>);

Deno.test("conflict reads: one raw-byte pair, literal BOM/CRLF/HTML, no content in list or closed response", async () => {
  const f = hubOperationsFixture();
  try {
    const original = "\ufeff# Original\r\n<script>never execute</script>\r\n",
      copy = "";
    Deno.writeTextFileSync(`${f.vault}/odd?:.md`, original);
    Deno.writeTextFileSync(`${f.vault}/copy.md`, copy);
    pair(f, "visible", "odd?:.md", "copy.md");
    const response = list();
    assertEquals(response.headers.get("cache-control"), "no-store");
    const packet = await response.json();
    assertEquals(packet.total, 1);
    assertEquals(packet.conflicts[0].path, "odd?:.md");
    assert(!JSON.stringify(packet).includes("never execute"));
    const read = detail(request("visible"));
    assertEquals(read.headers.get("cache-control"), "no-store");
    const comparison = await read.json();
    assertEquals(comparison.original.content, original);
    assertEquals(
      comparison.original.version,
      versionOf(new TextEncoder().encode(original)),
    );
    assertEquals(comparison.copy.content, "");
    assertEquals(comparison.copy.preview, "text");
    f.hub.closeConflict("visible", comparison.revision);
    const closed = await detail(request("visible")).json();
    assertEquals(Object.keys(closed).sort(), [
      "id",
      "resolvedAt",
      "revision",
      "state",
    ]);
    assertEquals(
      listConflicts({ hub: f.hub, stateRoot: f.config.statePath }).total,
      0,
    );
    assertThrows(() => detail(request("other-vault")));
    // No note bodies, drafts, patches or decoded HTML enter metadata.
    f.hub.store.checkpoint();
    assert(
      !new TextDecoder().decode(
        Deno.readFileSync(`${f.config.statePath}/hub.sqlite`),
      ).includes("never execute"),
    );
  } finally {
    f.close();
  }
});

Deno.test("conflict reads: binary, invalid UTF-8 and oversized Markdown never expose a lossy or truncated merge body", () => {
  const f = hubOperationsFixture();
  try {
    for (
      const [name, bytes, preview] of [
        ["binary", new Uint8Array([0, 255, 1]), "binary"],
        ["invalid.md", new Uint8Array([255]), "invalid_utf8"],
        ["large.md", new Uint8Array(16 * 1024 * 1024 + 1), "too_large"],
      ] as const
    ) {
      Deno.writeFileSync(`${f.vault}/${name}`, bytes);
      Deno.writeTextFileSync(`${f.vault}/copy.md`, "copy");
      pair(f, name, name, "copy.md");
      const comparison = readConflict({
        hub: f.hub,
        stateRoot: f.config.statePath,
      }, name);
      assert(comparison.state === "open");
      assertEquals(comparison.original.preview, preview);
      assertEquals(comparison.original.content, undefined);
      assertEquals(comparison.original.version, versionOf(bytes));
      assertEquals(comparison.original.size, bytes.length);
    }
  } finally {
    f.close();
  }
});

Deno.test("conflict reads: shared read projection hides state, reserved paths, escapes and descendant symlinks", () => {
  const f = hubOperationsFixture();
  try {
    Deno.writeTextFileSync(`${f.vault}/copy.md`, "copy");
    Deno.mkdirSync(`${f.vault}/.hidden`);
    Deno.mkdirSync(`${f.vault}/_`);
    for (const name of [".hidden/secret.md", "_/secret.md", "public.md"]) {
      Deno.writeTextFileSync(`${f.vault}/${name}`, "private");
    }
    Deno.symlinkSync(`${f.vault}/public.md`, `${f.vault}/alias.md`);
    // Insert directly to exercise projection even for forged/stale metadata.
    f.hub.scanNow();
    for (
      const [id, name] of [
        ["hidden", ".hidden/secret.md"],
        ["reserved", "_/secret.md"],
        ["symlink", "alias.md"],
        ["escape", "../outside.md"],
      ]
    ) {
      f.hub.store.db.prepare(
        `INSERT INTO conflicts VALUES(?,?,?,?,'key','globnotes','stale-base','open','now',NULL,1)`,
      )
        .run(id, name, "key", "copy.md");
      assertThrows(() =>
        readConflict({ hub: f.hub, stateRoot: f.config.statePath }, id)
      );
    }
    assertEquals(
      listConflicts({ hub: f.hub, stateRoot: f.config.statePath }).total,
      0,
    );
    pair(f, "visible", "public.md", "copy.md");
    assertEquals(
      listConflicts({ hub: f.hub, stateRoot: f.config.statePath }).total,
      1,
    );
    assertEquals(listConflicts({ hub: f.hub, stateRoot: f.vault }).total, 0);
    const otherRoot = `${f.root}/other`, otherState = `${f.root}/other-state`;
    Deno.mkdirSync(otherRoot);
    const other = new VaultHub(otherRoot, testMetadata(otherState));
    try {
      assertEquals(
        listConflicts({ hub: other, stateRoot: otherState }).total,
        0,
      );
      assertThrows(() =>
        readConflict({ hub: other, stateRoot: otherState }, "visible")
      );
    } finally {
      other.stop();
    }
  } finally {
    f.close();
  }
});

Deno.test("conflict reads: confirmed missing members close/scrub, equal bytes and edits do not", () => {
  const f = hubOperationsFixture();
  try {
    for (const name of ["original.md", "copy.md"]) {
      Deno.writeTextFileSync(`${f.vault}/${name}`, "same");
    }
    pair(f, "pair", "original.md", "copy.md");
    f.hub.scanNow();
    assertEquals(f.hub.conflict("pair")!.state, "open");
    Deno.writeTextFileSync(`${f.vault}/original.md`, "edited");
    f.hub.scanNow();
    assertEquals(f.hub.conflict("pair")!.state, "open");
    Deno.removeSync(`${f.vault}/copy.md`);
    const closed = readConflict(
      { hub: f.hub, stateRoot: f.config.statePath },
      "pair",
    );
    assertEquals(closed.state, "resolved");
    assertEquals(f.hub.conflict("pair")!.path, null);
    assertEquals(Deno.readTextFileSync(`${f.vault}/original.md`), "edited");
  } finally {
    f.close();
  }
});

Deno.test("conflict reads: an unreadable member propagates I/O failure without outside closure", () => {
  const f = hubOperationsFixture();
  try {
    Deno.mkdirSync(`${f.vault}/locked`);
    Deno.writeTextFileSync(`${f.vault}/original.md`, "original");
    Deno.writeTextFileSync(`${f.vault}/locked/copy.md`, "copy");
    pair(f, "pair", "original.md", "locked/copy.md");
    Deno.chmodSync(`${f.vault}/locked`, 0);
    try {
      assertThrows(
        () =>
          readConflict({ hub: f.hub, stateRoot: f.config.statePath }, "pair"),
        Deno.errors.PermissionDenied,
      );
      assertEquals(f.hub.conflict("pair")?.state, "open");
      assertEquals(f.hub.conflict("pair")?.revision, 1);
    } finally {
      Deno.chmodSync(`${f.vault}/locked`, 0o755);
    }
  } finally {
    f.close();
  }
});

Deno.test("conflict API: real HTTP choices reach disk, filtered inbox and ordinary note consumers", async () => {
  const root = Deno.makeTempDirSync({ prefix: "conflict-http-" });
  Deno.mkdirSync(`${root}/vault`);
  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: `${root}/vault`,
    GLOBNOTES__METADATA_PATH: `${root}/state`,
    fixtureAuth: { auth_type: "none" },
  });
  try {
    const json = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(server.baseUrl + "/_/api/" + route, {
        method,
        ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      const packet = await response.json();
      assertEquals(response.status, 200, JSON.stringify(packet));
      return packet;
    };
    for (const action of ["original", "copy", "both", "merge"]) {
      const name = `choice-${action}`;
      await json("notes", "POST", { path: name, content: "base\n" });
      Deno.writeTextFileSync(`${root}/vault/${name}.md`, "outside\n");
      const saved = await json("notes/" + name, "PATCH", {
        baseContent: "base\n",
        newContent: "copy\n",
      });
      assertEquals(saved.saveResult.status, "conflict");
      const inbox = await json("conflicts");
      assertEquals(inbox.total, 1);
      const id = inbox.conflicts[0].id;
      const comparison = await json("conflicts/" + id);
      assertEquals(comparison.original.content, "outside\n");
      assertEquals(comparison.copy.content, "copy\n");
      const receipt = await json(`conflicts/${id}/resolve`, "POST", {
        action,
        revision: comparison.revision,
        base: {
          original: { kind: "version", version: comparison.original.version },
          copy: { kind: "version", version: comparison.copy.version },
        },
        ...(action === "merge"
          ? { content: "# Keep this exact heading\r\n" }
          : {}),
      });
      assertEquals(receipt.status, "settled");
      const kept = action === "copy"
        ? "copy\n"
        : action === "merge"
        ? "# Keep this exact heading\r\n"
        : "outside\n";
      assertEquals(Deno.readTextFileSync(`${root}/vault/${name}.md`), kept);
      assertEquals((await json("notes/" + name)).content, kept);
      assertEquals((await json("conflicts")).total, 0);
      const copy = `${root}/vault/${saved.path}.md`;
      assertEquals(
        [...Deno.readDirSync(`${root}/vault`)].some((e) =>
          `${root}/vault/${e.name}` === copy
        ),
        action === "both",
      );
      const closed = await json("conflicts/" + id);
      assertEquals(Object.keys(closed).sort(), [
        "id",
        "resolvedAt",
        "revision",
        "state",
      ]);
    }
  } finally {
    await server.close();
    Deno.removeSync(root, { recursive: true });
  }
});
