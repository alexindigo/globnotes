// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Host admission, GLOBNOTES_ALLOWED_HOSTS (plans/mcp-interop §1 rows 6-7):
 * when set, every route answers a request whose Host is not listed with
 * 421, before routing; unset, every host is answered. Requests go over a
 * raw socket so each can carry the Host header a browser under DNS
 * rebinding would send.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  admitHost,
  type AllowedHost,
  AllowedHostsError,
  hostAllowed,
  parseAllowedHosts,
  rebindingWarning,
} from "../server/host_admission.ts";
import { bootServer, type TestServer } from "./helpers/boot.ts";

Deno.test("host admission: parsing GLOBNOTES_ALLOWED_HOSTS", () => {
  assertEquals(parseAllowedHosts(""), null);
  assertEquals(parseAllowedHosts(" , "), null);
  assertEquals(
    parseAllowedHosts(
      " Globnotes.HOME ,192.168.1.20:8080,[::1],[FE80::1]:80,::1, nas.home.",
    ),
    [
      { host: "globnotes.home", port: null },
      { host: "192.168.1.20", port: "8080" },
      { host: "[::1]", port: null },
      { host: "[fe80::1]", port: "80" },
      { host: "[::1]", port: null },
      { host: "nas.home", port: null },
    ],
  );
  for (
    const bad of [
      "http://globnotes.home",
      "globnotes.home/notes",
      "globnotes.home:0",
      "globnotes.home:65536",
      "globnotes.home:x",
      "[::1",
      "[::1]x",
      "bad host",
      "-lead.home",
    ]
  ) {
    let error: unknown;
    try {
      parseAllowedHosts(`ok.home,${bad}`);
    } catch (e) {
      error = e;
    }
    assert(error instanceof AllowedHostsError, bad);
    assert((error as Error).message.includes(bad), (error as Error).message);
  }
});

Deno.test("host admission: matching Host headers", () => {
  const allowed = parseAllowedHosts(
    "globnotes.home,192.168.1.20:8080,[::1]:8443",
  )!;
  const cases: [string | null, boolean][] = [
    ["globnotes.home", true],
    ["GlobNotes.Home:8080", true], // no port listed: any port
    ["globnotes.home.", true],
    ["globnotes.home:1", true],
    ["192.168.1.20:8080", true],
    ["192.168.1.20", false], // that entry needs its port
    ["192.168.1.20:80", false],
    ["[::1]:8443", true],
    ["[::1]", false],
    ["[::1]:8080", false],
    ["evil.example", false],
    ["globnotes.home.evil.example", false],
    ["", false],
    [null, false],
    ["globnotes.home:", false],
  ];
  for (const [host, expected] of cases) {
    assertEquals(hostAllowed(allowed, host), expected, String(host));
  }
});

Deno.test("host admission: unset admits every request; set refuses with 421", async () => {
  const request = (host: string) =>
    new Request("http://ignored/_/api/health", { headers: { host } });
  assertEquals(admitHost(null, request("evil.example")), null);
  const allowed: AllowedHost[] = [{ host: "globnotes.home", port: null }];
  assertEquals(admitHost(allowed, request("globnotes.home:8080")), null);
  const refused = admitHost(allowed, request("evil.example"))!;
  assertEquals(refused.status, 421);
  const { detail } = await refused.json();
  assert(detail.includes("'evil.example'"), detail);
  assert(detail.includes("GLOBNOTES_ALLOWED_HOSTS"), detail);
});

Deno.test("host admission: the startup warning", () => {
  const warning = rebindingWarning(true, null)!;
  assert(warning.includes("DNS rebinding"), warning);
  assert(warning.includes("GLOBNOTES_ALLOWED_HOSTS"), warning);
  assertEquals(rebindingWarning(true, [{ host: "a.home", port: null }]), null);
  assertEquals(rebindingWarning(false, null), null);
});

interface RawResponse {
  status: number;
  body: string;
}

/** One HTTP/1.1 request on a fresh connection, with exactly this Host. */
async function raw(
  server: TestServer,
  host: string,
  path: string,
  { method = "GET", body }: { method?: string; body?: string } = {},
): Promise<RawResponse> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: server.port });
  const payload = new TextEncoder().encode(body ?? "");
  const head = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Connection: close",
    ...(body === undefined ? [] : [
      "Content-Type: application/json",
      "Accept: application/json, text/event-stream",
      `Content-Length: ${payload.length}`,
    ]),
    "",
    "",
  ].join("\r\n");
  const writer = conn.writable.getWriter();
  await writer.write(new TextEncoder().encode(head));
  await writer.write(payload);
  writer.releaseLock();
  const text = await new Response(conn.readable).text();
  const status = Number(text.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
  return { status, body: text.slice(text.indexOf("\r\n\r\n") + 4) };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw", version: "1" },
  },
});

/** Every kind of route: web app, REST, a note, vault files, MCP. */
async function everyRoute(server: TestServer, host: string, prefix = "") {
  const statuses: Record<string, number> = {};
  for (
    const [name, path, options] of [
      ["web app", "/", {}],
      ["login page", "/_/login", {}],
      ["REST health", "/_/api/health", {}],
      ["REST note", "/_/api/notes/Welcome", {}],
      ["REST search", "/_/api/search?term=*", {}],
      ["file API", "/_/api/files/picture.txt", {}],
      ["vault file", "/picture.txt", {}],
      ["note page", "/Welcome", {}],
      ["MCP", "/_/mcp", { method: "POST", body: INITIALIZE }],
    ] as const
  ) {
    const response = await raw(server, host, prefix + path, options);
    statuses[name] = response.status;
    if (response.status === 421) {
      assert(
        response.body.includes("GLOBNOTES_ALLOWED_HOSTS"),
        `${name}: ${response.body}`,
      );
    }
  }
  return statuses;
}

async function seed(server: TestServer) {
  await Deno.writeTextFile(`${server.vault}/Welcome.md`, "# Welcome\n");
  await Deno.writeTextFile(`${server.vault}/picture.txt`, "a file\n");
}

const ALLOWED = "127.0.0.1,globnotes.home,[::1]:8443";

Deno.test("host admission: an unlisted host gets 421 on every route", async () => {
  const server = await bootServer({
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_ALLOWED_HOSTS: ALLOWED,
  });
  try {
    await seed(server);
    for (const host of ["evil.example", "[::1]:8080", "globnotes.home.evil"]) {
      const statuses = await everyRoute(server, host);
      assert(
        Object.values(statuses).every((status) => status === 421),
        `${host}: ${JSON.stringify(statuses)}`,
      );
    }
    for (
      const host of ["globnotes.home", "GLOBNOTES.home:9999", "[::1]:8443"]
    ) {
      const statuses = await everyRoute(server, host);
      assert(
        Object.values(statuses).every((status) => status !== 421),
        `${host}: ${JSON.stringify(statuses)}`,
      );
      assertEquals(statuses["REST health"], 200, host);
      assertEquals(statuses["MCP"], 200, host);
      assertEquals(statuses["vault file"], 200, host);
    }
    const { stdout, stderr } = server.logs();
    assert(!(stdout + stderr).includes("DNS rebinding"), "no warning when set");
  } finally {
    await server.close();
  }
});

Deno.test("host admission: unset, every host is answered and none mode warns", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await seed(server);
    const statuses = await everyRoute(server, "evil.example");
    assert(
      Object.values(statuses).every((status) => status !== 421),
      JSON.stringify(statuses),
    );
    assertEquals(statuses["REST health"], 200);
    assertEquals(statuses["MCP"], 200);
    const { stdout, stderr } = server.logs();
    assert((stdout + stderr).includes("DNS rebinding"), stdout + stderr);
  } finally {
    await server.close();
  }
  const readOnly = await bootServer({ GLOBNOTES_AUTH_TYPE: "read_only" });
  try {
    const { stdout, stderr } = readOnly.logs();
    assert(
      !(stdout + stderr).includes("DNS rebinding"),
      "only none mode warns",
    );
  } finally {
    await readOnly.close();
  }
});

Deno.test("host admission: applies before the path prefix", async () => {
  const server = await bootServer({
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_ALLOWED_HOSTS: ALLOWED,
    GLOBNOTES_PATH_PREFIX: "/mom",
  });
  try {
    await seed(server);
    const refused = await everyRoute(server, "evil.example", "/mom");
    assert(
      Object.values(refused).every((status) => status === 421),
      JSON.stringify(refused),
    );
    assertEquals((await raw(server, "evil.example", "/other")).status, 421);
    const listed = await everyRoute(server, "globnotes.home", "/mom");
    assertEquals(listed["REST health"], 200);
    assertEquals(listed["MCP"], 200);
    assertEquals((await raw(server, "globnotes.home", "/other")).status, 404);
  } finally {
    await server.close();
  }
});

Deno.test("host admission: an invalid setting stops startup", async () => {
  const error = await assertRejects(() =>
    bootServer({
      GLOBNOTES_AUTH_TYPE: "none",
      GLOBNOTES_ALLOWED_HOSTS: "globnotes.home,http://bad",
    })
  );
  assert(
    (error as Error).message.includes(
      "Invalid value for GLOBNOTES_ALLOWED_HOSTS",
    ),
    (error as Error).message,
  );
});
