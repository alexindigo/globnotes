import { fixturePasswordHash } from "./helpers/config.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The MCP tool-call rate limit, GLOBNOTES__MCP_RATELIMIT (plans/mcp-interop
 * §1 row 8): calls per minute per client, 429 with Retry-After over it, 0
 * disables it; the client is the authenticated subject, else the peer
 * address; the bookkeeping is bounded. The limiter is a plain module with an
 * injected clock; the endpoint runs in process with fake adapters, then a
 * real server shows the configuration and the route's peer address.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { GlobalConfig } from "./helpers/config.ts";
import { createMcpEndpoint } from "../server/mcp/endpoint.ts";
import { createRateLimiter } from "../server/mcp/rate_limit.ts";
import type { McpVault } from "../server/mcp/vault.ts";
import type { NoteMutationLease } from "../server/plugins/lifecycle.ts";
import { bootServer, type TestServer } from "./helpers/boot.ts";
import { testEnvironment } from "./helpers/environment.ts";

Deno.test("rate limit: a token bucket per client", () => {
  let now = 1_000;
  const limiter = createRateLimiter({ perMinute: 3, now: () => now })!;
  assertEquals(limiter.perMinute, 3);
  for (let i = 0; i < 3; i++) {
    assertEquals(limiter.take("a", 1), { allowed: true });
  }
  // Empty: one call refills in 20 s.
  assertEquals(limiter.take("a", 1), { allowed: false, retryAfterSeconds: 20 });
  // Another client has its own budget.
  assertEquals(limiter.take("b", 3), { allowed: true });
  now += 19_000;
  assertEquals(limiter.take("a", 1).allowed, false);
  now += 1_000;
  assertEquals(limiter.take("a", 1), { allowed: true });
  // A refused request takes nothing; two calls need 40 s.
  assertEquals(limiter.take("a", 2), { allowed: false, retryAfterSeconds: 40 });
  now += 60_000;
  // Refilled, but never above the limit.
  assertEquals(limiter.take("a", 3), { allowed: true });
  assertEquals(limiter.take("a", 1).allowed, false);
  // A request with more calls than the whole budget waits for a full one.
  now += 600_000;
  assertEquals(limiter.take("c", 5), { allowed: false, retryAfterSeconds: 1 });
  assertEquals(limiter.take("c", 0), { allowed: true });
});

Deno.test("rate limit: 0 disables it", () => {
  assertEquals(createRateLimiter({ perMinute: 0 }), null);
});

Deno.test("rate limit: memory stays bounded", () => {
  let now = 0;
  const limiter = createRateLimiter({
    perMinute: 600,
    maxClients: 100,
    now: () => now,
  })!;
  for (let i = 0; i < 10_000; i++) {
    limiter.take(`address:10.0.${i >> 8}.${i & 255}`, 1);
    now += 1;
    assert(limiter.size() <= 100, `${limiter.size()} buckets`);
  }
  assertEquals(limiter.size(), 100);
  // The most recent clients are the ones kept: their buckets still count.
  const recent = "address:10.0.39.15"; // i = 9,999
  for (let i = 1; i < 600; i++) assert(limiter.take(recent, 1).allowed);
  assertEquals(limiter.take(recent, 1).allowed, false);
});

const LEASE: NoteMutationLease = Object.freeze({
  epoch: 1,
  assertCurrent: () => {},
});

const emptyVault = {
  getNote: () => {
    throw new Error("unused");
  },
  listFolder: () => ({
    total: 0,
    folderCount: 0,
    noteCount: 0,
    folders: [],
    notes: [],
  }),
  search: () => ({ total: 0, results: [] }),
  tags: () => ({ total: 0, tags: [] }),
  createNote: () => Promise.reject(new Error("unused")),
  updateNote: () => Promise.reject(new Error("unused")),
  deleteNote: () => Promise.reject(new Error("unused")),
} satisfies McpVault;

const LEGACY = "2025-11-25";

function rpcBody(messages: { method: string; name?: string }[]) {
  const list = messages.map((m, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: m.method,
    params: m.name ? { name: m.name, arguments: {} } : {},
  }));
  return JSON.stringify(list.length === 1 ? list[0] : list);
}

const request = (
  messages: { method: string; name?: string }[],
  headers: Record<string, string> = {},
) =>
  new Request("http://notes.test/_/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LEGACY,
      ...headers,
    },
    body: rpcBody(messages),
  });

const TAGS = [{ method: "tools/call", name: "globnotes_list_tags" }];

Deno.test("rate limit: the endpoint answers 429 with Retry-After, per client", async (t) => {
  let now = 0;
  /** Subjects by token: two tokens of one account, as globnotes issues. */
  const subjects: Record<string, string> = {
    "Bearer one": "alice",
    "Bearer two": "alice",
    "Bearer other": "bob",
  };
  const endpoint = (authenticated: boolean) =>
    createMcpEndpoint({
      vault: emptyVault,
      writable: () => true,
      authenticateRead: (req) =>
        Promise.resolve(
          authenticated ? subjects[req.headers.get("authorization")!] : null,
        ),
      lease: () => Promise.resolve(LEASE),
      version: () => "test",
      rateLimiter: createRateLimiter({ perMinute: 2, now: () => now }),
    });

  await t.step("none mode: the peer address is the client", async () => {
    const mcp = endpoint(false);
    try {
      const from = (address: string) =>
        mcp.post(request(TAGS), { remoteAddress: address });
      for (let i = 0; i < 2; i++) {
        const ok = await from("10.0.0.1");
        assertEquals(ok.status, 200);
        assertEquals((await ok.json()).result.isError, undefined);
      }
      const over = await from("10.0.0.1");
      assertEquals(over.status, 429);
      assertEquals(over.headers.get("retry-after"), "30");
      const body = await over.json();
      assertEquals(body.jsonrpc, "2.0");
      assert(body.error.message.includes("2 per minute"), body.error.message);
      // Another address has its own budget; forwarded headers are ignored.
      assertEquals((await from("10.0.0.2")).status, 200);
      const forwarded = await mcp.post(
        request(TAGS, { "x-forwarded-for": "10.0.0.9" }),
        { remoteAddress: "10.0.0.1" },
      );
      assertEquals(forwarded.status, 429);
      await forwarded.body?.cancel();
      // Only tool calls count: listing the tools still works.
      const list = await mcp.post(request([{ method: "tools/list" }]), {
        remoteAddress: "10.0.0.1",
      });
      assertEquals(list.status, 200);
      await list.body?.cancel();
      // A batch counts each of its calls.
      now += 60_000;
      const batch = await mcp.post(request([...TAGS, ...TAGS, ...TAGS]), {
        remoteAddress: "10.0.0.3",
      });
      assertEquals(batch.status, 429);
      await batch.body?.cancel();
      assertEquals((await from("10.0.0.3")).status, 200);
    } finally {
      await mcp.close();
    }
  });

  await t.step(
    "auth on: the subject is the client, not the token",
    async () => {
      now += 600_000;
      const mcp = endpoint(true);
      try {
        const as = (token: string, address: string) =>
          mcp.post(request(TAGS, { authorization: `Bearer ${token}` }), {
            remoteAddress: address,
          });
        assertEquals((await as("one", "10.0.0.1")).status, 200);
        // A second token of the same account, from another address, shares
        // the budget: minting tokens doesn't raise the limit.
        assertEquals((await as("two", "10.0.0.2")).status, 200);
        const over = await as("two", "10.0.0.3");
        assertEquals(over.status, 429);
        assert(Number(over.headers.get("retry-after")) > 0);
        await over.body?.cancel();
        // Another subject has its own budget.
        assertEquals((await as("other", "10.0.0.1")).status, 200);
      } finally {
        await mcp.close();
      }
    },
  );
});

Deno.test("rate limit: a malformed tool call is counted and answered, never a crash (PR #28 review)", async () => {
  const MODERN = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const modernCall = (headers: Record<string, string>) =>
    new Request("http://notes.test/_/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "globnotes_list_tags", arguments: {}, _meta: MODERN },
      }),
    });
  for (
    const [label, headers] of [
      ["an undecodable Mcp-Name", { "mcp-name": "=?base64?***not base64?=" }],
      ["no Mcp-Name", {}],
    ] as [string, Record<string, string>][]
  ) {
    for (const writable of [true, false]) {
      const mcp = createMcpEndpoint({
        vault: emptyVault,
        writable: () => writable,
        authenticateRead: () => Promise.resolve(null),
        lease: () => Promise.resolve(LEASE),
        version: () => "test",
        rateLimiter: createRateLimiter({ perMinute: 1, now: () => 0 }),
      });
      try {
        const bad = await mcp.post(modernCall(headers), {
          remoteAddress: "10.0.0.1",
        });
        // The SDK's own answer to the header (a JSON-RPC error), not a 500.
        assert(
          bad.status >= 400 && bad.status < 500,
          `${label}: ${bad.status}`,
        );
        const body = await bad.json();
        assertEquals(body.jsonrpc, "2.0", label);
        assert(body.error, `${label}: ${JSON.stringify(body)}`);
        // It was counted: the budget of one is spent.
        const next = await mcp.post(request(TAGS), {
          remoteAddress: "10.0.0.1",
        });
        assertEquals(next.status, 429, `${label} (writable ${writable})`);
        await next.body?.cancel();
      } finally {
        await mcp.close();
      }
    }
  }
});

/** POST a 2025-era tools/call to the real server at `base`. */
async function callTags(base: string, token?: string): Promise<Response> {
  return await fetch(`${base}/_/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LEGACY,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: rpcBody(TAGS),
  });
}

async function statuses(base: string, count: number, token?: string) {
  const seen: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await callTags(base, token);
    seen.push(res.status);
    await res.body?.cancel();
  }
  return seen;
}

Deno.test("rate limit: a real server, GLOBNOTES__MCP_RATELIMIT and two addresses", async () => {
  // Listening on every address: loopback and the test domain's address are
  // two peers.
  const testHost = Deno.env.get("GLOBNOTES_TEST_HOST");
  const server = await bootServer({
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES__MCP_RATELIMIT: "3",
  }, { host: "0.0.0.0" });
  try {
    const loopback = `http://127.0.0.1:${server.port}`;
    assertEquals(await statuses(loopback, 4), [200, 200, 200, 429]);
    const over = await callTags(loopback);
    assertEquals(over.status, 429);
    // About 20 s until one call has refilled (3 per minute).
    const retry = Number(over.headers.get("retry-after"));
    assert(retry >= 1 && retry <= 20, String(retry));
    await over.body?.cancel();
    if (testHost) {
      const other = `http://${testHost}:${server.port}`;
      assertEquals(await statuses(other, 3), [200, 200, 200]);
    }
  } finally {
    await server.close();
  }
  assert(testHost, "GLOBNOTES_TEST_HOST names the second address");
});

Deno.test("rate limit: a real server, two tokens share the account's budget", async () => {
  const server = await bootServer({
    fixtureAuth: {
      auth_type: "password",
      username: "agent",
      password_hash: fixturePasswordHash("correct horse"),
      secret_key: "mcp-rate-limit-test-secret",
    },
    GLOBNOTES__MCP_RATELIMIT: "3",
  });
  const token = async () => {
    const login = await fetch(`${server.baseUrl}/_/api/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "agent", password: "correct horse" }),
    });
    return (await login.json()).access_token as string;
  };
  try {
    const first = await token();
    // Tokens carry their expiry in seconds: a later second, another token.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await token();
    assert(first !== second, "two different tokens");
    assertEquals(await statuses(server.baseUrl, 2, first), [200, 200]);
    assertEquals(await statuses(server.baseUrl, 2, second), [200, 429]);
    // Unauthenticated requests are refused before the limit and not counted.
    assertEquals(await statuses(server.baseUrl, 1), [401]);
  } finally {
    await server.close();
  }
});

Deno.test("rate limit: GLOBNOTES__MCP_RATELIMIT=0 disables it", async () => {
  const server: TestServer = await bootServer({
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES__MCP_RATELIMIT: "0",
  });
  try {
    const seen = await statuses(server.baseUrl, 30);
    assert(seen.every((status) => status === 200), JSON.stringify(seen));
  } finally {
    await server.close();
  }
});

Deno.test("rate limit: the setting defaults to 600 per minute", async () => {
  const vault = await Deno.makeTempDir({ prefix: "globnotes-rate-config-" });
  try {
    const config = (value?: string) =>
      new GlobalConfig(testEnvironment({
        GLOBNOTES_GLOBNOTES_PATH: vault,
        fixtureAuth: { auth_type: "none" },
        GLOBNOTES__MCP_RATELIMIT: value,
      })).mcpRateLimit;
    assertEquals(config(), 600);
    assertThrows(() => config(""), Error, "mcp.ratelimit");
    assertEquals(config("0"), 0);
    assertEquals(config("120"), 120);
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
