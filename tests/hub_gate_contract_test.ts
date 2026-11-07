// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The writer registry (docs/hub.md "Write gate"): every globnotes writer of
 * the vault is listed here with the base it states and what a stale base
 * does. The test discovers the writers from the code (NoteOperations'
 * mutation methods, the plugin actions, the plugin filesystem facade's
 * mutations, MCP write tools and the endpoints that call NoteOperations) and
 * fails when a writer is missing from the registry or the registry lists one
 * that no longer exists. Each NoteOperations writer and plugin action is then
 * driven on a real stack: without a base it is refused and nothing changes; a
 * stale base gives the registry's outcome. A new unconditional write path
 * therefore fails here (and its filesystem calls fail the contract rule
 * `single-vault-writer`).
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { NoteOperations } from "../server/notes/operations.ts";
import { PLUGIN_ACTIONS } from "../server/plugins/actions.ts";
import { AUXILIARY_MUTATIONS } from "../server/plugins/auxiliary_fs.ts";
import { WRITE_TOOLS } from "../server/mcp/server.ts";
import { versionOf } from "../server/hub/merge.ts";
import type { ActionReceipt } from "../server/plugins/contracts.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import resolveConflict from "../server/api/endpoints/_/api/conflicts/%23id/resolve/post.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";

type Base =
  | "absent"
  | "version|text"
  | "host-read"
  | "token"
  | "pair-of-version-bases";
type Stale = "refused" | "copy|refuse" | "merge|copy|refuse" | "n/a";
interface Writer {
  base: Base;
  stale: Stale;
}

/** Every writer of the vault. "host-read": the host derives the content
 * from its own read under the lock and refuses when that read is stale. */
const REGISTRY: Record<string, Writer> = {
  "operations.createNote": { base: "absent", stale: "refused" },
  "operations.updateNote": { base: "version|text", stale: "merge|copy|refuse" },
  "operations.deleteNote": { base: "version|text", stale: "refused" },
  "operations.resolveConflict": {
    base: "pair-of-version-bases",
    stale: "refused",
  },
  "operations.applyDriverImport": {
    base: "host-read",
    stale: "merge|copy|refuse",
  },
  "operations.uploadFile": { base: "absent", stale: "n/a" },
  "operations.rewriteRefs": { base: "host-read", stale: "refused" },
  "operations.writeExternalFile": {
    base: "version|text",
    stale: "copy|refuse",
  },
  "action.create": { base: "absent", stale: "refused" },
  "action.save": { base: "version|text", stale: "merge|copy|refuse" },
  "action.rename": { base: "version|text", stale: "refused" },
  "action.delete": { base: "version|text", stale: "refused" },
  "action.file-write": { base: "version|text", stale: "copy|refuse" },
  "fs.writeFile": { base: "token", stale: "refused" },
  "fs.rename": { base: "token", stale: "refused" },
  "fs.remove": { base: "token", stale: "refused" },
  "fs.mkdir": { base: "token", stale: "refused" },
  "mcp.globnotes_create_note": { base: "absent", stale: "refused" },
  "mcp.globnotes_update_note": { base: "version|text", stale: "refused" },
  "mcp.globnotes_delete_note": { base: "version|text", stale: "refused" },
  "rest.notes/post.ts": { base: "absent", stale: "refused" },
  "rest.notes/#...path/patch.ts": {
    base: "version|text",
    stale: "merge|copy|refuse",
  },
  "rest.notes/#...path/delete.ts": { base: "version|text", stale: "refused" },
  "rest.files/post.ts": { base: "absent", stale: "n/a" },
  "rest.files/rewrite-refs/post.ts": { base: "host-read", stale: "refused" },
  "rest.conflicts/#id/resolve/post.ts": {
    base: "pair-of-version-bases",
    stale: "refused",
  },
};

/** NoteOperations methods that do not write. */
const READ_METHODS = new Set(["constructor", "noteExists", "lifecycle"]);

async function endpointWriters(): Promise<string[]> {
  const root = path.fromFileUrl(
    new URL("../server/api/endpoints/", import.meta.url),
  );
  const found: string[] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) await walk(full);
      else if (entry.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(full);
        if (
          /state\.operations|NoteOperations|\.notes\.(?:commit|apply)/.test(
            text,
          )
        ) {
          found.push(
            path.relative(path.join(root, "_/api"), full).split(path.SEPARATOR)
              .join("/"),
          );
        }
      }
    }
  };
  await walk(root);
  return found;
}

Deno.test("writer registry: lists exactly the writers the code has", async () => {
  const discovered = [
    ...Object.getOwnPropertyNames(NoteOperations.prototype)
      .filter((name) => !READ_METHODS.has(name))
      .map((name) => `operations.${name}`),
    ...PLUGIN_ACTIONS.map((action) => `action.${action}`),
    ...AUXILIARY_MUTATIONS.map((method) => `fs.${method}`),
    ...WRITE_TOOLS.map((tool) => `mcp.${tool.name}`),
    ...(await endpointWriters()).map((file) => `rest.${file}`),
  ].sort();
  assertEquals(
    discovered,
    Object.keys(REGISTRY).sort(),
    "every vault writer states its base: register a new writer here with its base and stale outcome, and test it below",
  );
});

Deno.test("writer registry: NoteOperations writers refuse a missing base and honour a stale one", async () => {
  const f = hubOperationsFixture();
  try {
    const api = f.api();
    const disk = (name: string) => Deno.readTextFileSync(`${f.vault}/${name}`);
    const version = (name: string) =>
      versionOf(Deno.readFileSync(`${f.vault}/${name}`));
    await f.operations.createNote({ path: "note", content: "one" }, api);
    const code = (promise: Promise<unknown>) =>
      promise.then(() => "ok", (error) => error.code ?? error.name);
    // No base: refused, nothing changes.
    assertEquals(
      await code(
        f.operations.updateNote("note", { newContent: "x" }, "none", api),
      ),
      "base_required",
    );
    assertEquals(
      await code(
        f.operations.updateNote("note", { newPath: "moved" }, "none", api),
      ),
      "base_required",
    );
    assertEquals(
      await code(f.operations.deleteNote("note", api)),
      "base_required",
    );
    Deno.writeFileSync(`${f.vault}/data.bin`, new Uint8Array([1]));
    assertEquals(
      await code(f.operations.writeExternalFile(
        { kind: "file", absolutePath: `${f.vault}/data.bin` },
        new Uint8Array([2]),
        api,
      )),
      "base_required",
    );
    assertEquals(disk("note.md"), "one");
    assertEquals(Deno.readFileSync(`${f.vault}/data.bin`), new Uint8Array([1]));
    // Create: an occupied path is refused.
    assertEquals(
      await code(f.operations.createNote({ path: "note", content: "x" }, api)),
      "NoteExistsError",
    );
    // Stale bases.
    const stale = { kind: "version" as const, version: version("note.md") };
    Deno.writeTextFileSync(`${f.vault}/note.md`, "outside");
    const staleData = {
      kind: "version" as const,
      version: version("data.bin"),
    };
    Deno.writeFileSync(`${f.vault}/data.bin`, new Uint8Array([9]));
    assertEquals(
      await code(f.operations.updateNote(
        "note",
        { newContent: "x", base: stale, onStale: "refuse" },
        "none",
        api,
      )),
      "base_stale",
    );
    assertEquals(
      await code(
        f.operations.updateNote(
          "note",
          { newPath: "moved", base: stale },
          "none",
          api,
        ),
      ),
      "base_stale",
    );
    assertEquals(
      await code(
        f.operations.deleteNote(
          "note",
          api,
          undefined,
          undefined,
          undefined,
          stale,
        ),
      ),
      "base_stale",
    );
    assertEquals(
      await code(f.operations.writeExternalFile(
        { kind: "file", absolutePath: `${f.vault}/data.bin` },
        new Uint8Array([2]),
        api,
        undefined,
        undefined,
        staleData,
        "refuse",
      )),
      "base_stale",
    );
    const copy = await f.operations.updateNote(
      "note",
      { newContent: "mine", base: stale },
      "none",
      api,
    );
    assertEquals(copy.saveResult?.status, "conflict");
    const fileCopy = await f.operations.writeExternalFile(
      { kind: "file", absolutePath: `${f.vault}/data.bin` },
      new Uint8Array([2]),
      api,
      undefined,
      undefined,
      staleData,
    );
    assertEquals(fileCopy.saveResult.status, "conflict");
    assertEquals(disk("note.md"), "outside");
    assertEquals(Deno.readFileSync(`${f.vault}/data.bin`), new Uint8Array([9]));
    // Every effect above was recorded as a globnotes write, never local.
    f.hub.scanNow();
    const copies = f.hub.changesSince(0).entries.filter((e) =>
      e.path?.includes(".conflict-")
    );
    assertEquals(copies.map((e) => e.peer), ["globnotes", "globnotes"]);
    // Upload: a taken name gets a new one; nothing is replaced.
    const uploaded = await f.operations.uploadFile(
      "",
      "data.bin",
      new Uint8Array([3]),
      api,
    );
    assert(uploaded.filename !== "data.bin");
    assertEquals(Deno.readFileSync(`${f.vault}/data.bin`), new Uint8Array([9]));
  } finally {
    f.close();
  }
});

Deno.test("writer registry: plugin actions refuse a missing base and honour a stale one", async () => {
  const b = await pluginOperationsFixture({
    id: "writer",
    manifest: {
      runtime: { server: "service.js" },
      capabilities: { network: false, imports: false, write: ["vault"] },
    },
    files: {
      "service.js":
        `export function activate(ctx){ctx.commands.register({id:'request',label:'r',target:'server'},a=>ctx.actions.request(a.action,a.args));ctx.commands.register({id:'result',label:'q',target:'server'},id=>ctx.actions.result(id));}`,
    },
  });
  try {
    const run = async (action: string, args: Record<string, unknown>) => {
      const { requestId } = await b.command("request", { action, args }) as {
        requestId: string;
      };
      let receipt: ActionReceipt | undefined;
      await waitUntil(async () => {
        receipt = await b.command("result", requestId) as ActionReceipt;
        return ["accepted", "running"].includes(receipt.status)
          ? pending(receipt)
          : done();
      }, { label: `${action} receipt` });
      return receipt!.error?.code ?? receipt!.status;
    };
    await b.create("note", "one");
    const vault = b.fixture.vault;
    const stale = {
      kind: "version",
      version: versionOf(Deno.readFileSync(`${vault}/note.md`)),
    };
    const bytes = new Uint8Array([1]);
    for (const action of PLUGIN_ACTIONS) {
      if (action === "create") continue;
      const args: Record<string, unknown> = action === "file-write"
        ? { path: "note.md", bytes }
        : action === "rename"
        ? { path: "note", newPath: "moved" }
        : { path: "note", newContent: "x" };
      assertEquals(await run(action, args), "base_required", action);
    }
    assertEquals(
      await run("create", { path: "note", content: "x" }),
      "plugin_action_failed",
      "an occupied path refuses a create",
    );
    Deno.writeTextFileSync(`${vault}/note.md`, "outside");
    for (const action of PLUGIN_ACTIONS) {
      if (action === "create") continue;
      const args: Record<string, unknown> = action === "file-write"
        ? { path: "note.md", bytes, base: stale, onStale: "refuse" }
        : action === "rename"
        ? { path: "note", newPath: "moved", base: stale }
        : { path: "note", newContent: "x", base: stale, onStale: "refuse" };
      assertEquals(await run(action, args), "base_stale", action);
    }
    assertEquals(Deno.readTextFileSync(`${vault}/note.md`), "outside");
  } finally {
    await b.close();
  }
});

Deno.test("writer registry: every resolution action and REST writer refuses missing/stale pair bases", async () => {
  const f = hubOperationsFixture();
  try {
    Deno.writeTextFileSync(`${f.vault}/original.md`, "keeper");
    Deno.writeTextFileSync(`${f.vault}/copy.md`, "loser");
    f.hub.recordConflict({
      id: "reviewed",
      path: "original.md",
      copyPath: "copy.md",
      peer: "globnotes",
      reason: "stale-base",
      state: "open",
      createdAt: "now",
      resolvedAt: null,
    });
    const base = {
      original: {
        kind: "version",
        version: versionOf(new TextEncoder().encode("keeper")),
      },
      copy: {
        kind: "version",
        version: versionOf(new TextEncoder().encode("loser")),
      },
    };
    for (const action of ["original", "copy", "both", "merge"]) {
      for (const member of ["original", "copy"] as const) {
        for (const missing of [true, false]) {
          const body = {
            action,
            revision: f.hub.conflict("reviewed")!.revision,
            base: {
              ...base,
              [member]: missing
                ? undefined
                : { kind: "version", version: "0".repeat(64) },
            },
            ...(action === "merge" ? { content: "draft" } : {}),
          };
          const operation = await f.operations.resolveConflict(
            "reviewed",
            body,
            f.api(),
          ).catch((e) => e);
          assertEquals(
            [operation.status, operation.code],
            missing ? [428, "base_required"] : [409, "conflict_stale"],
          );
          const response = await resolveConflict(
            {
              _raw: new Request(
                "http://fixture/_/api/conflicts/reviewed/resolve",
                { method: "POST" },
              ),
              params: { id: "reviewed" },
              body: { json: () => Promise.resolve(body) },
            } as unknown as PathfinderRequest<{ id: string }>,
          );
          assertEquals(response.status, missing ? 428 : 409);
          assertEquals(
            (await response.json()).code,
            missing ? "base_required" : "conflict_stale",
          );
          assertEquals(
            Deno.readTextFileSync(`${f.vault}/original.md`),
            "keeper",
          );
          assertEquals(Deno.readTextFileSync(`${f.vault}/copy.md`), "loser");
          assertEquals(f.hub.conflict("reviewed")!.state, "open");
        }
      }
    }
  } finally {
    f.close();
  }
});
