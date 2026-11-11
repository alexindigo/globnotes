import { fixturePasswordHash } from "./helpers/config.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The MCP endpoint against malformed, unusual and concurrent traffic on a
 * real server (plans/mcp-v3 S1 row 2), with raw HTTP rather than an SDK
 * client: what any client can send, and that every answer is a single JSON
 * body (docs/mcp.md: stateless, no server-sent event streams). Storage
 * failures on the real disk never show the agent the server's paths.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { SignJWT } from "jose";
import type { TestServer } from "./helpers/boot.ts";
import { bootOnTestDomain as boot } from "./helpers/mcp.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

const ACCEPT = "application/json, text/event-stream";
const LEGACY = "2025-11-25";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface Reply {
  status: number;
  contentType: string | null;
  // deno-lint-ignore no-explicit-any
  body: any;
}

/** POST raw text; the reply must be JSON (or empty), never an SSE stream. */
async function send(
  server: TestServer,
  body: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(`${server.baseUrl}/_/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
    body,
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type");
  assert(contentType !== "text/event-stream", `SSE reply: ${text}`);
  assertEquals(res.headers.get("mcp-session-id"), null, "no sessions");
  return {
    status: res.status,
    contentType,
    body: text === "" ? null : JSON.parse(text),
  };
}

const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  JSON.stringify({
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    method,
    ...(params === undefined ? {} : { params }),
  });

/** A 2025-era call (stateless: no initialize needed). */
const callTool = (
  server: TestServer,
  name: string,
  args: unknown,
  id = 1,
  headers: Record<string, string> = {},
) =>
  send(server, rpc("tools/call", { name, arguments: args }, id), {
    "mcp-protocol-version": LEGACY,
    ...headers,
  });

/** A 2026-07-28 request with its metadata headers. */
const modern = (
  server: TestServer,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  send(server, rpc(method, { ...params, _meta: MODERN_META }), {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...headers,
  });

const initialize = (version: string) =>
  rpc("initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "raw", version: "1" },
  });

Deno.test("mcp protocol: malformed, unsupported and unusual requests", async () => {
  const server = await boot({ fixtureAuth: { auth_type: "none" } });
  try {
    for (const body of ["{", ""]) {
      const reply = await send(server, body);
      assertEquals([reply.status, reply.body.error.code], [400, -32700], body);
    }
    const plain = await send(server, initialize(LEGACY), {
      "content-type": "text/plain",
    });
    assertEquals(plain.status, 415);
    for (const accept of ["application/json", "text/event-stream"]) {
      const reply = await send(server, initialize(LEGACY), { accept });
      assertEquals(reply.status, 406, accept);
    }
    // Bodies over the SDK's 4 MiB bound are refused before parsing.
    const oversized = await send(
      server,
      rpc("tools/call", {
        name: "globnotes_create_note",
        arguments: { path: "Big", content: "x".repeat(4 * 1024 * 1024) },
      }),
      { "mcp-protocol-version": LEGACY },
    );
    assertEquals(oversized.status, 413);
    assert(!await exists(path.join(server.vault, "Big.md")));

    // Notifications and stray responses are accepted without a body.
    for (
      const body of [
        rpc("notifications/initialized", undefined, null),
        JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }),
      ]
    ) {
      const reply = await send(server, body, {
        "mcp-protocol-version": LEGACY,
      });
      assertEquals([reply.status, reply.body], [202, null], body);
    }

    // Protocol negotiation: each 2025 revision is echoed; an unknown one
    // gets the latest; the modern era names what it supports.
    for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", LEGACY]) {
      const reply = await send(server, initialize(version));
      assertEquals(reply.status, 200);
      assertEquals(reply.contentType, "application/json");
      assertEquals(reply.body.result.protocolVersion, version);
      assertEquals(reply.body.result.capabilities.tools.listChanged, false);
    }
    const unknown = await send(server, initialize("1999-01-01"));
    assertEquals(unknown.body.result.protocolVersion, LEGACY);
    const badHeader = await send(server, rpc("tools/list"), {
      "mcp-protocol-version": "1999-01-01",
    });
    assertEquals(badHeader.status, 400);
    const discover = await modern(server, "server/discover");
    assertEquals(discover.body.result.supportedVersions, ["2026-07-28"]);
    const future = await send(
      server,
      rpc("tools/list", {
        _meta: {
          ...MODERN_META,
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
        },
      }),
      { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
    );
    assertEquals([future.status, future.body.error.code], [400, -32022]);
    assertEquals(future.body.error.data.supported, ["2026-07-28"]);
    const mismatch = await modern(server, "tools/call", {
      name: "globnotes_list_tags",
      arguments: {},
    }, { "mcp-name": "globnotes_get_note" });
    assertEquals([mismatch.status, mismatch.body.error.code], [400, -32020]);

    // Unknown methods and tools.
    const legacyMethod = await send(server, rpc("foo/bar"), {
      "mcp-protocol-version": LEGACY,
    });
    assertEquals(legacyMethod.body.error.code, -32601);
    const modernMethod = await modern(server, "foo/bar");
    assertEquals([modernMethod.status, modernMethod.body.error.code], [
      404,
      -32601,
    ]);
    const listen = await modern(server, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    assertEquals([listen.status, listen.body.error.code], [404, -32601]);
    const tool = await callTool(server, "globnotes_nope", {});
    assertEquals(tool.body.error.code, -32602);

    // Invalid arguments are tool errors the agent can read.
    for (
      const [name, args] of [
        ["globnotes_search_notes", { query: "x", limit: 0 }],
        ["globnotes_search_notes", { query: "x", bogus: 1 }],
        ["globnotes_get_note", { path: 5 }],
        ["globnotes_get_note", {}],
      ] as const
    ) {
      const reply = await callTool(server, name, args);
      assertEquals(reply.body.result.isError, true, JSON.stringify(args));
      assert(
        reply.body.result.content[0].text.startsWith("Input validation error"),
      );
    }

    // A 2025-03-26 batch is answered as one JSON array.
    const batch = await send(
      server,
      JSON.stringify([
        JSON.parse(rpc("tools/list", undefined, 1)),
        JSON.parse(rpc("foo/bar", undefined, 2)),
      ]),
      { "mcp-protocol-version": "2025-03-26" },
    );
    assertEquals(batch.status, 200);
    assertEquals(
      (batch.body as { id: number }[]).map((reply) => reply.id).sort(),
      [1, 2],
    );
  } finally {
    await server.close();
  }
});

Deno.test("mcp protocol: 50 concurrent tool calls", async () => {
  const server = await boot({ fixtureAuth: { auth_type: "none" } });
  try {
    const replies = await Promise.all(
      Array.from(
        { length: 50 },
        (_, i) =>
          i % 2
            ? callTool(server, "globnotes_create_note", {
              path: `Load/n${i}`,
              content: `# n${i}\n\nconcurrent`,
            }, i)
            : callTool(server, "globnotes_search_notes", { query: "*" }, i),
      ),
    );
    for (const [i, reply] of replies.entries()) {
      assertEquals(reply.status, 200, `call ${i}`);
      assertEquals(reply.body.id, i);
      assertEquals(reply.body.result.isError, undefined, `call ${i}`);
    }
    const written = await Promise.all(
      Array.from({ length: 25 }, (_, k) => 2 * k + 1).map((i) =>
        Deno.readTextFile(path.join(server.vault, `Load/n${i}.md`))
      ),
    );
    assertEquals(
      written.filter((text) => text.endsWith("concurrent")).length,
      25,
    );
    // Concurrent creates of one path: exactly one wins.
    const same = await Promise.all(
      Array.from(
        { length: 10 },
        (_, i) =>
          callTool(server, "globnotes_create_note", {
            path: "Load/same",
            content: `# same ${i}`,
          }, 100 + i),
      ),
    );
    assertEquals(
      same.filter((reply) => reply.body.result.isError === undefined).length,
      1,
    );
  } finally {
    await server.close();
  }
});

Deno.test("mcp protocol: a token that expires between calls", async () => {
  const secret = "mcp-protocol-test-secret";
  const server = await boot({
    fixtureAuth: {
      auth_type: "password",
      username: "agent",
      password_hash: fixturePasswordHash("correct horse"),
      secret_key: secret,
    },
  });
  try {
    // The server's own token format, with a two-second lifetime.
    const token = await new SignJWT({ sub: "agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("2s")
      .sign(new TextEncoder().encode(secret));
    const auth = { authorization: `Bearer ${token}` };
    const first = await callTool(server, "globnotes_list_tags", {}, 1, auth);
    assertEquals(first.status, 200);
    assertEquals(first.body.result.isError, undefined);
    const expired = await waitUntil(async () => {
      const reply = await callTool(server, "globnotes_list_tags", {}, 2, auth);
      return reply.status === 401 ? done(reply) : pending(reply.status);
    }, { label: "token expiry", intervalMs: 250, children: [server] });
    assertEquals(expired.body.detail, "Invalid authentication credentials");
  } finally {
    await server.close();
  }
});

Deno.test("mcp protocol: storage failures don't show server paths", async () => {
  const outside = await Deno.makeTempDir({ prefix: "globnotes-mcp-outside-" });
  const server = await boot({ fixtureAuth: { auth_type: "none" } });
  try {
    const vault = server.vault;
    await Deno.mkdir(path.join(vault, "Folder.md"));
    await Deno.writeTextFile(path.join(vault, "Locked.md"), "# Locked\n");
    await Deno.chmod(path.join(vault, "Locked.md"), 0o000);
    await Deno.symlink(outside, path.join(vault, "Elsewhere"));
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "globnotes_get_note",
        { path: "Folder" },
        "can't read 'Folder' as a note",
      ],
      ["globnotes_delete_note", {
        path: "Folder",
        expected_hash: "0".repeat(64),
      }, "can't read 'Folder'"],
      ["globnotes_list_folder", { path: "Elsewhere" }, "Invalid folder"],
      ["globnotes_list_folder", { path: "Locked.md" }, "not found"],
      ["globnotes_get_note", { path: "x".repeat(300) }, "unexpected server"],
      ["globnotes_search_notes", { query: '"open' }, "can't parse the query"],
    ];
    // A root test process can read any file, so permissions only bite
    // when this process can't read the file either.
    const unreadable = await Deno.readTextFile(path.join(vault, "Locked.md"))
      .then(() => false, () => true);
    if (unreadable) {
      cases.push(
        ["globnotes_get_note", { path: "Locked" }, "no permission to access"],
        [
          "globnotes_update_note",
          { path: "Locked", content: "x", expected_hash: "0".repeat(64) },
          "no permission",
        ],
      );
    }
    for (const [name, args, expected] of cases) {
      const reply = await callTool(server, name, args);
      const text = reply.body.result.content[0].text as string;
      assertEquals(reply.body.result.isError, true, name);
      assert(text.includes(expected), `${name}: ${text}`);
      assert(!text.includes(vault) && !text.includes("os error"), text);
    }
    await Deno.chmod(path.join(vault, "Locked.md"), 0o644);
  } finally {
    await server.close();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("mcp protocol: the endpoint lives under the path prefix", async () => {
  const server = await boot({
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES__SERVER_PATHPREFIX: "/mom",
  });
  try {
    const post = (url: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: initialize(LEGACY),
      });
    const prefixed = await post(`${server.baseUrl}/mom/_/mcp`);
    assertEquals(prefixed.status, 200);
    assertEquals(
      (await prefixed.json()).result.serverInfo.name,
      "globnotes-mcp-server",
    );
    const root = await post(`${server.baseUrl}/_/mcp`);
    assertEquals(root.status, 404);
    await root.body?.cancel();
  } finally {
    await server.close();
  }
});

Deno.test("mcp protocol: a 1,000-note folder and 3,000 tags page within the budget", async () => {
  const vault = await Deno.makeTempDir({ prefix: "globnotes-mcp-pages-" });
  await Deno.mkdir(path.join(vault, "Flat"));
  for (let i = 0; i < 1_000; i++) {
    await Deno.writeTextFile(
      path.join(vault, "Flat", `Note ${String(i).padStart(4, "0")}.md`),
      `# Note ${i}\n`,
    );
  }
  const tags = Array.from({ length: 3_000 }, (_, i) => `tag${i}`);
  await Deno.writeTextFile(
    path.join(vault, "Tagged.md"),
    `# Tagged\n\n${tags.map((t) => `#${t}`).join(" ")}\n`,
  );
  const server = await boot({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    fixtureAuth: { auth_type: "none" },
  });
  try {
    await waitUntil(async () => {
      const reply = await callTool(server, "globnotes_list_tags", {});
      const total = reply.body.result.structuredContent.total;
      return total === 3_000 ? done() : pending(total);
    }, { label: "tags indexed", intervalMs: 100, children: [server] });
    for (
      const [name, args, total] of [
        ["globnotes_list_folder", { path: "Flat", limit: 500 }, 1_000],
        ["globnotes_list_tags", { limit: 2_000 }, 3_000],
      ] as const
    ) {
      const seen: string[] = [];
      for (let offset = 0, id = 1;; id++) {
        const reply = await callTool(server, name, { ...args, offset }, id);
        const page = reply.body.result.structuredContent;
        const text = reply.body.result.content[0].text as string;
        assert(
          text.length + JSON.stringify(page).length <= 25_000,
          `${name} at ${offset}`,
        );
        assertEquals(page.total, total);
        seen.push(
          ...(page.notes?.map((n: { path: string }) => n.path) ?? page.tags),
        );
        if (!page.has_more) break;
        offset = page.next_offset;
      }
      assertEquals(new Set(seen).size, total, name);
      assertEquals(seen.length, total, name);
    }
  } finally {
    await server.close();
    await Deno.remove(vault, { recursive: true });
  }
});

async function exists(file: string): Promise<boolean> {
  try {
    await Deno.stat(file);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
