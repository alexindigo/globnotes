// SPDX-License-Identifier: LGPL-3.0-only

/**
 * MCP over v3's vault hub (docs/hub.md): the endpoint's default adapters
 * (server/mcp/vault.ts) on a real hub, index and NoteOperations, driven by
 * the SDK client in process. MCP writes are the `globnotes` peer with
 * origin `api` in the hub log, and search follows that log: a managed write
 * is searchable at once, an outside edit once the hub has observed it. The
 * stale-write guard compares the note on disk, so an outside edit refuses a
 * stale update whether or not the hub has seen it yet.
 */

import { assert, assertEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpEndpoint } from "../server/mcp/endpoint.ts";
import type { ChangeEntry } from "../server/hub/types.ts";
import { state } from "../server/state.ts";
import { restoreState, setupState } from "./helpers/state.ts";

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (result: Result) =>
  (result.content as { text: string }[]).map((block) => block.text).join(
    "\n",
  );

Deno.test("mcp on the hub: writes are the globnotes peer, search follows the log", async () => {
  const previous = { ...state };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-mcp-hub-" });
  const s = setupState(vault);
  state.lifecycle = s.lifecycle;
  state.operations = s.operations;
  // Note entries only: this fixture keeps its index files inside the vault.
  const batches: ChangeEntry[][] = [];
  s.hub.subscribe((entries) =>
    batches.push(
      entries.filter((e) => (e.path ?? e.oldPath ?? "").startsWith("Hub/")),
    )
  );
  s.hub.scanNow();
  const endpoint = createMcpEndpoint({
    writable: () => true,
    authenticateRead: () => Promise.resolve(),
    lease: () => Promise.resolve(s.api().lease),
    version: () => "test",
  });
  const client = new Client({ name: "mcp-hub-test", version: "1.0.0" });
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
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assertEquals(result.isError, undefined, `${name}: ${textOf(result)}`);
    return result.structuredContent as Record<string, unknown>;
  };
  const search = async (query: string) =>
    ((await call("globnotes_search_notes", { query })).results as {
      path: string;
    }[]).map((r) => r.path);
  try {
    // Managed writes: in the hub log as globnotes/api and searchable at once.
    const created = await call("globnotes_create_note", {
      path: "Hub/Agent",
      content: "# Agent\n\nhubneedle",
    });
    assertEquals(await search("hubneedle"), ["Hub/Agent"]);
    const updated = await call("globnotes_update_note", {
      path: "Hub/Agent",
      content: "# Agent\n\nhubnext",
      expected_last_modified: created.last_modified,
    });
    assertEquals(await search("hubneedle"), []);
    assertEquals(await search("hubnext"), ["Hub/Agent"]);
    await call("globnotes_update_note", {
      path: "Hub/Agent",
      new_path: "Hub/Moved",
      expected_last_modified: updated.last_modified,
    });
    assertEquals(await search("hubnext"), ["Hub/Moved"]);
    const entries = batches.flat();
    assertEquals(entries.map((e) => e.kind), [
      "created",
      "modified",
      "renamed",
    ]);
    assert(
      entries.every((e) => e.peer === "globnotes" && e.origin === "api"),
      JSON.stringify(entries),
    );

    // An outside edit: the guard refuses a stale update before the hub has
    // observed the edit; search shows the edit once the hub has.
    const read = await call("globnotes_get_note", { path: "Hub/Moved" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Deno.writeTextFile(
      `${vault}/Hub/Moved.md`,
      "# Agent\n\noutsideneedle",
    );
    const stale = await client.callTool({
      name: "globnotes_update_note",
      arguments: {
        path: "Hub/Moved",
        content: "# Agent\n\nmine",
        expected_last_modified: read.last_modified,
      },
    });
    assertEquals(stale.isError, true);
    assert(textOf(stale).includes("changed since you read it"));
    assertEquals(
      await Deno.readTextFile(`${vault}/Hub/Moved.md`),
      "# Agent\n\noutsideneedle",
    );
    assertEquals(await search("outsideneedle"), [], "search never scans");
    s.hub.scanNow();
    assertEquals(await search("outsideneedle"), ["Hub/Moved"]);
    const outside = batches.flat().at(-1)!;
    assertEquals([outside.kind, outside.peer], ["modified", "local"]);

    const fresh = await call("globnotes_get_note", { path: "Hub/Moved" });
    const deleted = await call("globnotes_delete_note", {
      path: "Hub/Moved",
      expected_last_modified: fresh.last_modified,
    });
    assertEquals(deleted, { deleted: "Hub/Moved" });
    assertEquals(await search("outsideneedle"), []);
    const last = batches.flat().at(-1)!;
    assertEquals(
      [last.kind, last.peer, last.origin],
      ["deleted", "globnotes", "api"],
    );
  } finally {
    await client.close();
    await endpoint.close();
    s.hub.stop();
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
