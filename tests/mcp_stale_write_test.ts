// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The MCP stale-write guard on the real NoteOperations and hub
 * (server/notes/expectation.ts): expected_last_modified and expected_hash
 * are checked under the note lock, so a writer that lands between an
 * agent's check and its write is detected instead of overwritten. A plugin
 * guard that holds the first write open makes the interleaving exact.
 */

import { assert, assertEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { contentVersion } from "../server/hub/merge.ts";
import { createMcpEndpoint } from "../server/mcp/endpoint.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import type { PluginRuntime } from "../server/plugins/runtime.ts";
import { state } from "../server/state.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (result: Result) =>
  (result.content as { text: string }[]).map((block) => block.text).join(
    "\n",
  );

/** A hub fixture whose operations run `onGuard` for every plugin guard. */
async function fixture(
  onGuard: (hook: string) => void | Promise<void> = () => {},
) {
  const f = hubOperationsFixture();
  const runtime = {
    limits: { preOperationMs: 5000 },
    guard: async (hook: string) => {
      await onGuard(hook);
      return [];
    },
    assertGuardAuthority() {},
  } as unknown as PluginRuntime;
  const operations = new NoteOperations({
    notes: f.notes,
    files: f.files,
    hub: f.hub,
    indexer: null,
    lifecycle: f.lifecycle,
    runtime: () => runtime,
  });
  state.operations = operations;
  // Calls that reached NoteOperations (past any tool-level work).
  let updates = 0;
  const update = operations.updateNote.bind(operations);
  operations.updateNote = (...args) => {
    updates++;
    return update(...args);
  };
  const endpoint = createMcpEndpoint({
    writable: () => true,
    authenticateRead: () => Promise.resolve(null),
    lease: () => Promise.resolve(f.api().lease),
    version: () => "test",
  });
  const client = new Client({ name: "mcp-stale-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://notes.test/_/mcp"), {
      fetch: (url, init) => {
        const request = new Request(url, init);
        return request.method === "POST"
          ? endpoint.post(request)
          : Promise.resolve(endpoint.notAllowed(request));
      },
    }),
  );
  return {
    ...f,
    operations,
    updates: () => updates,
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    async close() {
      await client.close();
      await endpoint.close();
      f.close();
    },
  };
}

/** A note created through the operations, with an mtime in the past, so a
 * later write always changes last_modified. */
async function seed(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
  content: string,
) {
  await f.operations.createNote({ path, content }, f.api());
  const past = new Date("2026-01-01T00:00:00Z");
  Deno.utimeSync(`${f.vault}/${path}.md`, past, past);
  const read = await f.call("globnotes_get_note", { path });
  assertEquals(read.isError, undefined, textOf(read));
  return read.structuredContent as { last_modified: string; hash: string };
}

for (const guard of ["expected_last_modified", "expected_hash"] as const) {
  Deno.test(`mcp stale writes: two agents with the same ${guard} - the second is refused`, async () => {
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let holding = true;
    const f = await fixture(async (hook) => {
      if (hook === "pre-save" && holding) {
        holding = false;
        held.resolve();
        await release.promise;
      }
    });
    try {
      const read = await seed(f, "Race", "# Race\n\nbase\n");
      const expected = guard === "expected_hash"
        ? { expected_hash: read.hash }
        : { expected_last_modified: read.last_modified };
      // A is admitted and held inside the note lock, after its check.
      const first = f.call("globnotes_update_note", {
        path: "Race",
        content: "# Race\n\nfirst agent\n",
        ...expected,
      });
      await held.promise;
      // B read the same version; it reaches the operations while A holds the
      // lock, so any check outside the lock would still see the old note.
      const second = f.call("globnotes_update_note", {
        path: "Race",
        content: "# Race\n\nsecond agent\n",
        ...expected,
      });
      await waitUntil(
        () => f.updates() >= 2 ? done() : pending({ updates: f.updates() }),
        { label: "second update reached NoteOperations" },
      );
      release.resolve();
      const [a, b] = await Promise.all([first, second]);
      assertEquals(a.isError, undefined, textOf(a));
      assertEquals(b.isError, true, textOf(b));
      assert(
        textOf(b).startsWith("Note 'Race' changed since you read it ("),
        textOf(b),
      );
      assert(textOf(b).includes("Nothing was written."), textOf(b));
      assertEquals(
        await Deno.readTextFile(`${f.vault}/Race.md`),
        "# Race\n\nfirst agent\n",
      );
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

Deno.test("mcp stale writes: an outside write between the check and the write is detected", async (t) => {
  let outside: (() => void) | null = null;
  const f = await fixture((hook) => {
    if ((hook === "pre-save" || hook === "pre-delete") && outside) {
      const write = outside;
      outside = null;
      write();
    }
  });
  try {
    for (const tool of ["globnotes_update_note", "globnotes_delete_note"]) {
      await t.step(tool, async () => {
        const path = tool === "globnotes_update_note" ? "Outside" : "Gone";
        const read = await seed(f, path, "# Outside\n\nbase\n");
        const theirs = "# Outside\n\nwritten by another program\n";
        // Runs inside the operation, after the guard's first check.
        outside = () => Deno.writeTextFileSync(`${f.vault}/${path}.md`, theirs);
        const result = await f.call(tool, {
          path,
          ...(tool === "globnotes_update_note" ? { content: "mine" } : {}),
          expected_hash: read.hash,
        });
        assertEquals(result.isError, true, textOf(result));
        assertEquals(
          textOf(result),
          `Note '${path}' changed since you read it (expected hash ${read.hash}, ` +
            `now ${contentVersion(theirs)}). Nothing was written. Call ` +
            "globnotes_get_note to re-read it, then retry with the new hash.",
        );
        assertEquals(await Deno.readTextFile(`${f.vault}/${path}.md`), theirs);
      });
    }
  } finally {
    await f.close();
  }
});

Deno.test("mcp stale writes: reads and writes return the hub's content hash", async () => {
  const f = await fixture();
  try {
    const created = await f.call("globnotes_create_note", {
      path: "Hashed",
      content: "# Hashed\n",
    });
    const hash = (created.structuredContent as { hash: string }).hash;
    f.hub.scanNow();
    assertEquals(hash, f.hub.fileState("Hashed.md")!.hash);
    const read = await f.call("globnotes_get_note", { path: "Hashed" });
    assertEquals((read.structuredContent as { hash: string }).hash, hash);
    const updated = await f.call("globnotes_update_note", {
      path: "Hashed",
      content: "# Hashed\n\nmore\n",
      expected_hash: hash,
    });
    assertEquals(updated.isError, undefined, textOf(updated));
    f.hub.scanNow();
    assertEquals(
      (updated.structuredContent as { hash: string }).hash,
      f.hub.fileState("Hashed.md")!.hash,
    );
  } finally {
    await f.close();
  }
});
