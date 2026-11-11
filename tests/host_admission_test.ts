import { fixturePasswordHash } from "./helpers/config.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Host admission, GLOBNOTES__SERVER_ALLOWEDHOSTS (plans/mcp-interop §1 rows 6-7):
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
  createRebindingWarner,
  hostAllowed,
  parseAllowedHosts,
  rebindingWarning,
} from "../server/host_admission.ts";
import { GlobalConfig } from "./helpers/config.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { bootServer, type TestServer } from "./helpers/boot.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

Deno.test("host admission: parsing GLOBNOTES__SERVER_ALLOWEDHOSTS", () => {
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
      "[1:2]", // not an IPv6 address
      "[::g]",
      "nas.1", // a numeric last label is IPv4 to a browser, and not valid
      "user@globnotes.home",
      "globnotes%2ehome",
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

Deno.test("host admission: every spelling of an address is one entry (PR #28 review)", () => {
  // Entries and Host headers share one canonical form (WHATWG URL hosts,
  // what browsers send): IPv6 compressed and lowercase, IPv4 dotted
  // decimal, names lowercase without a trailing dot, ports as numbers.
  assertEquals(
    parseAllowedHosts(
      "[0:0:0:0:0:0:0:1],[FE80:0::0001]:0080,::FFFF:127.0.0.1,127.1," +
        "0x7f.0.0.2,NAS.Home.:08080",
    ),
    [
      { host: "[::1]", port: null },
      { host: "[fe80::1]", port: "80" },
      { host: "[::ffff:7f00:1]", port: null },
      { host: "127.0.0.1", port: null },
      { host: "127.0.0.2", port: null },
      { host: "nas.home", port: "8080" },
    ],
  );
  const cases: [string, string, boolean][] = [
    // [entry, Host header, admitted]
    ["[0:0:0:0:0:0:0:1]", "[::1]:8080", true],
    ["[::1]", "[0:0::1]", true],
    ["::1", "[::1]", true],
    ["[::1]:8080", "[0000:0000::0001]:8080", true],
    ["[::1]:8080", "[::1]:8081", false],
    ["[fe80::1]", "[FE80::1]", true],
    ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", true],
    ["[::1]", "[::2]", false],
    ["127.0.0.1", "127.1:80", true],
    ["127.0.0.1:8080", "127.000.000.001:8080", true],
    ["127.0.0.1", "0127.0.0.1", false], // a leading 0 is octal: 87.0.0.1
    ["127.0.0.1:8080", "0x7F.0.0.1:08080", true],
    ["192.168.1.20", "192.168.1.21", false],
    ["Globnotes.Home", "GLOBNOTES.HOME.", true],
    ["globnotes.home.", "globnotes.home:80", true],
    ["globnotes.home:80", "globnotes.home", false], // a port entry needs it
    ["globnotes.home:80", "globnotes.home:080", true],
    ["globnotes.home", "user@globnotes.home", false],
    ["globnotes.home", "globnotes.home.evil", false],
  ];
  for (const [entry, host, expected] of cases) {
    assertEquals(
      hostAllowed(parseAllowedHosts(entry)!, host),
      expected,
      `${entry} vs ${host}`,
    );
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
  assert(detail.includes("GLOBNOTES__SERVER_ALLOWEDHOSTS"), detail);
});

Deno.test("host admission: the rebinding warning", () => {
  const open = (authType: string | null, setupRequired = false) => ({
    setupRequired,
    authType,
    allowedHosts: null,
  });
  const none = rebindingWarning(open("none"))!;
  assert(none.includes("DNS rebinding"), none);
  assert(none.includes("GLOBNOTES__SERVER_ALLOWEDHOSTS"), none);
  assert(none.includes("change them"), none);
  const readOnly = rebindingWarning(open("read_only"))!;
  assert(readOnly.includes("read_only mode") && !readOnly.includes("change"));
  for (const quiet of [open("password"), open("totp"), open(null, true)]) {
    assertEquals(rebindingWarning(quiet), null, JSON.stringify(quiet));
  }
  assertEquals(
    rebindingWarning({
      ...open("none"),
      allowedHosts: [{ host: "a.home", port: null }],
    }),
    null,
  );
});

Deno.test("host admission: one warning per transition into exposure (PR #28 review)", () => {
  const warnings: string[] = [];
  const warner = createRebindingWarner((message) => warnings.push(message));
  const step = (authType: string | null, setupRequired = false) => {
    warner.update({ setupRequired, authType, allowedHosts: null });
    return warnings.length;
  };
  assertEquals(step(null, true), 0, "setup pending: not exposed");
  assertEquals(step("none"), 1, "setup completed as none");
  assertEquals(step("none"), 1, "still none: no repeat");
  assertEquals(step("read_only"), 2, "none -> read_only");
  assertEquals(step("password"), 2, "a login: not exposed");
  assertEquals(step("read_only"), 3, "password -> read_only");
  warner.update({
    setupRequired: false,
    authType: "none",
    allowedHosts: [{ host: "globnotes.home", port: null }],
  });
  assertEquals(warnings.length, 3, "an allow-list: not exposed");
  assert(warnings[1].includes("read_only mode"), warnings[1]);
});

Deno.test("host admission: access-policy changes notify their listeners", () => {
  const config = new GlobalConfig(testEnvironment({
    fixtureAuth: { auth_type: "none" },
  }));
  const lifecycle = new PluginLifecycle(config);
  let calls = 0;
  const stop = lifecycle.onPolicyChange(() => calls++);
  lifecycle.onPolicyChange(() => {
    throw new Error("a failing listener");
  });
  assertEquals(lifecycle.bumpEpoch(), 1);
  assertEquals(calls, 1);
  stop();
  lifecycle.bumpEpoch();
  assertEquals(calls, 1);
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
        response.body.includes("GLOBNOTES__SERVER_ALLOWEDHOSTS"),
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
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES__SERVER_ALLOWEDHOSTS: ALLOWED,
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

Deno.test("host admission: unset, every host is answered and open modes warn", async () => {
  const server = await bootServer({ fixtureAuth: { auth_type: "none" } });
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
  // read_only needs no login to read, so it warns too (PR #28 review);
  // the allow-list or a login silences the warning.
  for (
    const [env, warns] of [
      [{ fixtureAuth: { auth_type: "read_only" } }, true],
      [{
        fixtureAuth: { auth_type: "read_only" },
        GLOBNOTES__SERVER_ALLOWEDHOSTS: "127.0.0.1",
      }, false],
      [{
        fixtureAuth: {
          auth_type: "password",
          username: "agent",
          password_hash: fixturePasswordHash("correct horse"),
          secret_key: "host-admission-test-secret",
        },
      }, false],
    ] as [Record<string, unknown>, boolean][]
  ) {
    const other = await bootServer(env);
    try {
      const { stdout, stderr } = other.logs();
      assertEquals(
        (stdout + stderr).includes("DNS rebinding"),
        warns,
        JSON.stringify(env),
      );
    } finally {
      await other.close();
    }
  }
});

Deno.test("host admission: applies before the path prefix", async () => {
  const server = await bootServer({
    fixtureAuth: { auth_type: "none" },
    GLOBNOTES__SERVER_ALLOWEDHOSTS: ALLOWED,
    GLOBNOTES__SERVER_PATHPREFIX: "/mom",
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

Deno.test("host admission: setup and access changes into exposure warn at runtime (PR #28 review)", async () => {
  // Started with setup pending: no warning yet.
  const server = await bootServer({});
  const warnings = () =>
    (server.output.stdout + server.output.stderr).split("DNS rebinding")
      .length - 1;
  const api = async (route: string, method = "GET", data?: unknown) => {
    const response = await fetch(`${server.baseUrl}/_/api/${route}`, {
      method,
      headers: data === undefined ? {} : { "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const warned = (count: number, label: string) =>
    waitUntil(
      () => warnings() >= count ? done() : pending({ warnings: warnings() }),
      { label, intervalMs: 25, children: [server] },
    );
  try {
    assertEquals(warnings(), 0, "setup pending");
    assertEquals((await api("setup", "POST", { mode: "none" })).status, 200);
    await warned(1, "a warning after setup completes as none");
    const view = (await api("access")).body;
    const changed = await api("access", "PUT", {
      mode: "read_only",
      revision: view.revision,
      signature: view.signature,
    });
    assertEquals(changed.status, 200, JSON.stringify(changed.body));
    await warned(2, "a warning after the access change to read_only");
    assert(
      (server.output.stdout + server.output.stderr).includes(
        "No login is needed (read_only mode)",
      ),
    );
    // A request after the change: still two (one per transition).
    assertEquals((await api("health")).status, 200);
    assertEquals(warnings(), 2);
  } finally {
    await server.close();
  }
});

Deno.test("host admission: an invalid setting stops startup", async () => {
  const error = await assertRejects(() =>
    bootServer({
      fixtureAuth: { auth_type: "none" },
      GLOBNOTES__SERVER_ALLOWEDHOSTS: "globnotes.home,http://bad",
    })
  );
  assert(
    (error as Error).message.includes(
      "server.allowedhosts (GLOBNOTES__SERVER_ALLOWEDHOSTS)",
    ),
    (error as Error).message,
  );
});
