// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Reads of existing vault content use the read-path name rule
 * (isReadableNotePath), never the stricter create-time rule: real vaults hold
 * folders and files named with characters a new name can't (`?`, `:`, `*`).
 * A folder listing and a search folder filter of such a folder used to fail
 * as an invalid path while the notes inside read fine. Creating a new name
 * keeps the create-time rule. (Vault file GETs keep their own documented
 * contract: invalid characters answer 400, tests/files_test.ts.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpEndpoint } from "../server/mcp/endpoint.ts";
import { state } from "../server/state.ts";
import { awaitIndexReady, restoreState, setupState } from "./helpers/state.ts";

const ODD = "Odd?:*";

Deno.test("read paths: an existing folder named with ? : * lists and filters", async () => {
  const previous = { ...state };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-read-rule-" });
  await Deno.mkdir(`${vault}/${ODD}`);
  await Deno.writeTextFile(`${vault}/${ODD}/Note.md`, "# Note\n\noddneedle\n");
  const s = setupState(vault);
  s.indexer.startBackgroundSync();
  await awaitIndexReady(s.indexer);
  const endpoint = createMcpEndpoint({
    writable: () => true,
    authenticateRead: () => Promise.resolve(),
    lease: () =>
      Promise.resolve(Object.freeze({ epoch: 1, assertCurrent: () => {} })),
    version: () => "test",
  });
  const client = new Client({ name: "read-rule-test", version: "1.0.0" });
  try {
    // Storage and index.
    assertEquals(s.notes.listLevel(ODD).notes, [`${ODD}/Note`]);
    assertEquals(s.notes.get(`${ODD}/Note`).content, "# Note\n\noddneedle\n");
    assertEquals(
      s.indexer.search("oddneedle", "score", "desc", undefined, true, ODD)
        .map((r) => r.path),
      [`${ODD}/Note`],
    );

    // MCP: list the folder, search inside it; a new name keeps the create rule.
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://notes.test/_/mcp"), {
        fetch: (url, init) => endpoint.post(new Request(url, init)),
      }),
    );
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const listed = await call("globnotes_list_folder", { path: ODD });
    assertEquals(listed.isError, undefined, JSON.stringify(listed.content));
    assertEquals(
      (listed.structuredContent as { notes: { path: string }[] }).notes
        .map((n) => n.path),
      [`${ODD}/Note`],
    );
    const found = await call("globnotes_search_notes", {
      query: "oddneedle",
      folder: ODD,
    });
    assertEquals(found.isError, undefined, JSON.stringify(found.content));
    assertEquals(
      (found.structuredContent as { results: { path: string }[] }).results
        .map((r) => r.path),
      [`${ODD}/Note`],
    );
    const created = await call("globnotes_create_note", {
      path: `${ODD}/New`,
      content: "x",
    });
    assertEquals(created.isError, true);
    assert(
      (created.content as { text: string }[])[0].text.startsWith(
        `Invalid path '${ODD}/New'`,
      ),
    );
  } finally {
    await client.close();
    await endpoint.close();
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
