import { fixturePasswordHash } from "./helpers/config.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The MCP endpoint on a real server (plans/v2-mcp/design.md §5 row 2):
 * the SDK client with its Streamable HTTP transport, on the local test
 * domain `http://$GLOBNOTES_TEST_HOST:<port>` (docs/testing.md), never
 * loopback. Writes are checked on disk and in the index; a plugin pre-save
 * guard cancels an MCP write.
 */

import { contentVersion } from "../server/hub/merge.ts";
import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { type Client, SdkHttpError } from "@modelcontextprotocol/client";
import type { TestServer } from "./helpers/boot.ts";
import {
  bootOnTestDomain as boot,
  connectMcp as connect,
  FIXTURE_NOTES,
  fixtureVaultCopy as vaultCopy,
} from "./helpers/mcp.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { catalogPluginReady } from "./helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

const ALL_TOOLS = [
  "globnotes_create_note",
  "globnotes_delete_note",
  "globnotes_get_note",
  "globnotes_list_folder",
  "globnotes_list_tags",
  "globnotes_search_notes",
  "globnotes_update_note",
];
const READ_TOOLS = ALL_TOOLS.filter((name) =>
  !/_(create|update|delete)_note$/.test(name)
);
const READ_ONLY =
  "This globnotes instance is read-only: notes can be searched and read, " +
  "but not created, changed or deleted.";

type Result = Awaited<ReturnType<Client["callTool"]>>;

const textOf = (result: Result) =>
  (result.content as { text: string }[]).map((block) => block.text).join(
    "\n",
  );

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assertEquals(result.isError, undefined, `${name}: ${textOf(result)}`);
  return result.structuredContent as Record<string, unknown>;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

/** Wait until the background index holds the whole fixture vault. */
function indexed(client: Client, server: TestServer) {
  return waitUntil(async () => {
    const page = await call(client, "globnotes_search_notes", {
      query: "*",
      limit: 100,
    });
    return page.count === FIXTURE_NOTES ? done() : pending(page.count);
  }, { label: "fixture vault indexed", intervalMs: 100, children: [server] });
}

function post(server: TestServer, headers: Record<string, string> = {}) {
  return fetch(`${server.baseUrl}/_/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    }),
  });
}

/** Every tool once, writes checked on disk and in the index. */
async function exerciseAllTools(
  client: Client,
  vault: string,
  folder: string,
) {
  // The server's instructions arrive with the handshake.
  assert(
    client.getInstructions()?.includes("globnotes_search_notes"),
    String(client.getInstructions()),
  );
  const root = await call(client, "globnotes_list_folder");
  assertEquals(
    (root.folders as { name: string }[]).map((f) => f.name).filter((name) =>
      name !== "Inbox"
    ),
    ["Books", "Garden", "Journal", "Recipes", "Travel", "Work"],
  );
  assertEquals(root.notes, [{ path: "Welcome", title: "Welcome" }]);

  const tags = await call(client, "globnotes_list_tags");
  assert((tags.tags as string[]).includes("book-review"), String(tags.tags));

  const vegetarian = await call(client, "globnotes_search_notes", {
    query: "#vegetarian",
    sort: "path",
    order: "asc",
  });
  assertEquals(
    (vegetarian.results as { path: string }[]).map((r) => r.path),
    [
      "Recipes/Lentil dal",
      "Recipes/Matcha castella",
      "Recipes/Mushroom risotto",
      "Recipes/Ratatouille",
    ],
  );
  const phrase = await call(client, "globnotes_search_notes", {
    query: '"cooking class"',
  });
  const hit = (phrase.results as { path: string; snippet: string }[])[0];
  assertEquals(hit.path, "Travel/2025-Japan/Day 5 Kyoto");
  assert(hit.snippet.includes("joined a «cooking class» near"), hit.snippet);

  const beds = await call(client, "globnotes_get_note", {
    path: "Garden/Beds",
  });
  assert((beds.content as string).includes("Bush beans"));

  const notePath = `${folder}/Agent note`;
  const file = (p: string) => path.join(vault, `${p}.md`);
  const created = await call(client, "globnotes_create_note", {
    path: notePath,
    content: "# Agent note\n\nWritten over MCP. #mcp-written",
  });
  assertEquals(created.path, notePath);
  assertEquals(
    await Deno.readTextFile(file(notePath)),
    "# Agent note\n\nWritten over MCP. #mcp-written",
  );
  const found = await call(client, "globnotes_search_notes", {
    query: "#mcp-written",
    folder,
  });
  assertEquals(
    (found.results as { path: string }[]).map((r) => r.path),
    [notePath],
  );

  // Changing the first H1 renames the note, as in the web app.
  const updated = await call(client, "globnotes_update_note", {
    path: notePath,
    content: "# Agent renamed\n\nEdited over MCP.",
    expected_last_modified: created.last_modified,
  });
  const renamed = `${folder}/Agent renamed`;
  assertEquals(updated.path, renamed);
  assertEquals(
    await Deno.readTextFile(file(renamed)),
    "# Agent renamed\n\nEdited over MCP.",
  );
  assert(!await exists(file(notePath)));
  const reindexed = await call(client, "globnotes_search_notes", {
    query: "edited",
    folder,
  });
  assertEquals(
    (reindexed.results as { path: string }[]).map((r) => r.path),
    [renamed],
  );

  const stale = await client.callTool({
    name: "globnotes_delete_note",
    arguments: {
      path: renamed,
      expected_last_modified: created.last_modified,
    },
  });
  assertEquals(stale.isError, true);
  assert(textOf(stale).includes("changed since you read it"));
  assert(await exists(file(renamed)));

  const deleted = await call(client, "globnotes_delete_note", {
    path: renamed,
    expected_last_modified: updated.last_modified,
  });
  assertEquals(deleted, { deleted: renamed });
  assert(!await exists(file(renamed)));
  const gone = await call(client, "globnotes_search_notes", {
    query: "edited",
    folder,
  });
  assertEquals(gone.count, 0);
}

async function exists(file: string): Promise<boolean> {
  try {
    await Deno.stat(file);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("mcp endpoint: none mode, both protocol eras, every tool", async () => {
  const vault = await vaultCopy();
  const server = await boot({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    fixtureAuth: { auth_type: "none" },
  });
  try {
    for (const modern of [false, true]) {
      const client = await connect(server, { modern });
      try {
        assertEquals(client.getProtocolEra(), modern ? "modern" : "legacy");
        assertEquals(client.getServerVersion()?.name, "globnotes-mcp-server");
        assertEquals(await toolNames(client), ALL_TOOLS);
        await indexed(client, server);
        await exerciseAllTools(
          client,
          vault,
          modern ? "Inbox/modern" : "Inbox/legacy",
        );
      } finally {
        await client.close();
      }
    }
  } finally {
    await server.close();
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("mcp endpoint: a single long token stays within the response limit", async () => {
  const server = await boot({ fixtureAuth: { auth_type: "none" } });
  try {
    const client = await connect(server);
    try {
      // One 30,000-character word (under FTS5's 32,768-byte token limit): the
      // index's snippet window counts tokens, so its snippet holds the whole
      // word, more than the 25,000-character response budget.
      const word = "abcdefghij".repeat(3_000);
      await call(client, "globnotes_create_note", {
        path: "Long token",
        content: `# Long token\n\nbefore ${word} after\n`,
      });
      const result = await client.callTool({
        name: "globnotes_search_notes",
        arguments: { query: "abcdefghijabcdefghij*" },
      });
      assertEquals(result.isError, undefined, textOf(result));
      const page = result.structuredContent as {
        count: number;
        results: { path: string; snippet: string }[];
      };
      assertEquals(page.count, 1);
      assertEquals(page.results[0].path, "Long token");
      const snippet = page.results[0].snippet;
      assert(snippet.includes("«abcdefghij"), snippet.slice(0, 60));
      assert(snippet.endsWith(" ... [truncated]"), snippet.slice(-60));
      assert(
        textOf(result).length + JSON.stringify(page).length <= 25_000,
        "within the response budget",
      );
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
});

Deno.test("mcp endpoint: a long title and a long tag stay within the response limit", async () => {
  const server = await boot({ fixtureAuth: { auth_type: "none" } });
  try {
    const client = await connect(server);
    try {
      const title = "Heading ".repeat(2_500).trim(); // ~20,000 characters
      const tag = "abcdefghij".repeat(2_000); // one 20,000-character tag
      const content = `---\ntitle: ${title}\n---\n\nNotes #${tag}\n`;
      await call(client, "globnotes_create_note", { path: "Huge", content });
      const result = await client.callTool({
        name: "globnotes_search_notes",
        arguments: { query: "abcdefghijabcdefghij*" },
      });
      assertEquals(result.isError, undefined, textOf(result));
      const page = result.structuredContent as {
        count: number;
        results: {
          path: string;
          title: string;
          matched_tags: string[];
          truncated?: string[];
        }[];
      };
      assertEquals(page.count, 1);
      const [hit] = page.results;
      assertEquals(hit.path, "Huge");
      assertEquals(hit.truncated, ["snippet", "matched_tags", "title"]);
      assert(hit.title.startsWith("Heading Heading"), hit.title.slice(0, 40));
      assert(hit.title.endsWith(" ... [truncated]"));
      assertEquals(hit.matched_tags.length, 1);
      assert(hit.matched_tags[0].startsWith("abcdefghij"));
      assert(hit.matched_tags[0].endsWith(" ... [truncated]"));
      assert(
        textOf(result).length + JSON.stringify(page).length <= 25_000,
        "within the response budget",
      );
      // The path stays usable: the whole note reads back, in parts (it is
      // over the response limit), with its long title shortened.
      const parts: string[] = [];
      for (let offset: number | undefined = 0; offset !== undefined;) {
        const note = await call(client, "globnotes_get_note", {
          path: hit.path,
          offset,
        });
        assertEquals(note.offset, offset);
        assertEquals(note.truncated, ["title"]);
        assert((note.title as string).startsWith("Heading Heading"));
        parts.push(note.content as string);
        offset = note.next_offset as number | undefined;
      }
      assert(parts.length > 1, "more than one part");
      assertEquals(parts.join(""), content);
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
});

Deno.test("mcp endpoint: transport rules (405, Origin, Allow)", async () => {
  const server = await boot({ fixtureAuth: { auth_type: "none" } });
  try {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${server.baseUrl}/_/mcp`, { method });
      assertEquals(res.status, 405, method);
      assertEquals(res.headers.get("allow"), "POST");
      await res.body?.cancel();
    }
    const foreign = await post(server, { origin: "http://evil.example" });
    assertEquals(foreign.status, 403);
    assertEquals((await foreign.json()).error.code, -32000);
    const sameOrigin = await post(server, { origin: server.baseUrl });
    assertEquals(sameOrigin.status, 200);
    await sameOrigin.body?.cancel();
  } finally {
    await server.close();
  }
});

Deno.test("mcp endpoint: password mode needs the API token", async () => {
  const server = await boot({
    fixtureAuth: {
      auth_type: "password",
      username: "agent",
      password_hash: fixturePasswordHash("correct horse"),
      secret_key: "mcp-endpoint-test-secret",
    },
  });
  try {
    const anonymous = await post(server);
    assertEquals(anonymous.status, 401);
    assertEquals(anonymous.headers.get("www-authenticate"), "Bearer");
    await anonymous.body?.cancel();
    const forged = await post(server, { authorization: "Bearer nope" });
    assertEquals(forged.status, 401);
    await forged.body?.cancel();
    let rejected: unknown;
    try {
      await connect(server);
    } catch (error) {
      rejected = error;
    }
    assert(rejected instanceof SdkHttpError, String(rejected));

    const login = await fetch(`${server.baseUrl}/_/api/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "agent", password: "correct horse" }),
    });
    assertEquals(login.status, 200);
    const token = (await login.json()).access_token as string;
    for (const modern of [false, true]) {
      const client = await connect(server, { modern, token });
      try {
        assertEquals(await toolNames(client), ALL_TOOLS);
        const name = modern ? "modern" : "legacy";
        const created = await call(client, "globnotes_create_note", {
          path: `Token/${name}`,
          content: `# ${name}\n`,
        });
        assertEquals(created.path, `Token/${name}`);
        const read = await call(client, "globnotes_get_note", {
          path: `Token/${name}`,
        });
        assertEquals(read.content, `# ${name}\n`);
        assertEquals(
          await Deno.readTextFile(path.join(server.vault, `Token/${name}.md`)),
          `# ${name}\n`,
        );
      } finally {
        await client.close();
      }
    }
  } finally {
    await server.close();
  }
});

Deno.test("mcp endpoint: read_only lists the read tools and refuses writes", async () => {
  const vault = await vaultCopy();
  const server = await boot({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    fixtureAuth: { auth_type: "read_only" },
  });
  try {
    for (const modern of [false, true]) {
      const client = await connect(server, { modern });
      try {
        assertEquals(await toolNames(client), READ_TOOLS);
        await indexed(client, server);
        const note = await call(client, "globnotes_get_note", {
          path: "Books/Piranesi",
        });
        assert((note.content as string).includes("Susanna Clarke"));
        for (
          const [name, args] of [
            ["globnotes_create_note", { path: "New", content: "x" }],
            ["globnotes_update_note", { path: "Welcome", content: "x" }],
            ["globnotes_delete_note", { path: "Welcome" }],
          ] as const
        ) {
          const result = await client.callTool({ name, arguments: args });
          assertEquals(result.isError, true, name);
          assertEquals(textOf(result), READ_ONLY, name);
        }
        assert(!await exists(path.join(vault, "New.md")));
        assert(
          (await Deno.readTextFile(path.join(vault, "Welcome.md")))
            .startsWith("# Welcome"),
        );
      } finally {
        await client.close();
      }
    }
  } finally {
    await server.close();
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("mcp endpoint: GLOBNOTES__MCP_ENABLED=false answers 404", async () => {
  const server = await boot({
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES__MCP_ENABLED: "false",
  });
  try {
    const res = await post(server);
    assertEquals(res.status, 404);
    await res.body?.cancel();
    const get = await fetch(`${server.baseUrl}/_/mcp`);
    assertEquals(get.status, 404);
    await get.body?.cancel();
  } finally {
    await server.close();
  }
});

Deno.test("mcp endpoint: a plugin pre-save guard cancels an MCP write", async () => {
  const fixture = await pluginFixture();
  try {
    await fixture.install("guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
    }, {
      "service.js": `export function activate(ctx) {
        ctx.hooks.on('pre-save', (fact) => {
          if ((fact?.proposed?.content ?? '').includes('#BLOCK#')) return { cancel: true, reason: 'no blocked content' };
        });
      }`,
    });
    await Deno.writeTextFile(path.join(fixture.vault, "doc.md"), "# Doc\n");
    const server = await boot({
      GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_METADATA_PATH: fixture.metadataBase,
      fixtureAuth: { auth_type: "none" },
    });
    try {
      await catalogPluginReady(server, "guard");
      const client = await connect(server);
      try {
        const blocked = await client.callTool({
          name: "globnotes_update_note",
          arguments: {
            path: "doc",
            content: "# Doc\n#BLOCK#",
            expected_hash: contentVersion("# Doc\n"),
          },
        });
        assertEquals(blocked.isError, true);
        assertEquals(
          textOf(blocked),
          "The plugin 'guard' cancelled this save: no blocked content " +
            "Nothing was written.",
        );
        assertEquals(
          await Deno.readTextFile(path.join(fixture.vault, "doc.md")),
          "# Doc\n",
        );
        const allowed = await call(client, "globnotes_update_note", {
          path: "doc",
          content: "# Doc\nfine",
          expected_hash: contentVersion("# Doc\n"),
        });
        assertEquals(allowed.content, "# Doc\nfine");
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("mcp endpoint: plugin guards cancel MCP creates, renames and deletes", async () => {
  const fixture = await pluginFixture();
  try {
    await fixture.install("guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-create", "pre-rename", "pre-delete"],
    }, {
      "service.js": `export function activate(ctx) {
        for (const hook of ['pre-create', 'pre-rename', 'pre-delete']) {
          ctx.hooks.on(hook, (fact) => {
            if (JSON.stringify(fact).includes('Guarded')) return { cancel: true, reason: 'guarded' };
          });
        }
      }`,
    });
    await Deno.writeTextFile(
      path.join(fixture.vault, "Guarded.md"),
      "# Guarded\n",
    );
    await Deno.writeTextFile(path.join(fixture.vault, "doc.md"), "# doc\n");
    const server = await boot({
      GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_METADATA_PATH: fixture.metadataBase,
      fixtureAuth: { auth_type: "none" },
    });
    try {
      await catalogPluginReady(server, "guard");
      const client = await connect(server);
      try {
        for (
          const [name, args, action] of [
            [
              "globnotes_create_note",
              { path: "New/Guarded", content: "x" },
              "create",
            ],
            [
              "globnotes_update_note",
              {
                path: "doc",
                new_path: "Guarded too",
                expected_hash: contentVersion("# doc\n"),
              },
              "rename",
            ],
            ["globnotes_delete_note", {
              path: "Guarded",
              expected_hash: contentVersion("# Guarded\n"),
            }, "delete"],
          ] as const
        ) {
          const result = await client.callTool({ name, arguments: args });
          assertEquals(result.isError, true, name);
          assertEquals(
            textOf(result),
            `The plugin 'guard' cancelled this ${action}: guarded Nothing was written.`,
          );
        }
        const disk = (p: string) => exists(path.join(fixture.vault, p));
        assertEquals(
          await Promise.all(
            ["New/Guarded.md", "Guarded too.md", "doc.md", "Guarded.md"].map(
              disk,
            ),
          ),
          [false, false, true, true],
        );
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    await fixture.dispose();
  }
});
