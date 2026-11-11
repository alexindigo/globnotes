// SPDX-License-Identifier: LGPL-3.0-only

/** Shared pieces of the MCP server tests: a server on the local test
 * domain, an SDK client for it, and copies of the fixture vault. */

import { copy } from "@std/fs";
import * as path from "@std/path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { testOrigin } from "../../client/tests/e2e/http-origin.mjs";
import { bootServer, type TestServer } from "./boot.ts";
import { command } from "./process.ts";

export const FIXTURE_VAULT = path.fromFileUrl(
  new URL("../fixtures/mcp/vault/", import.meta.url),
);
/** Notes in the fixture vault. */
export const FIXTURE_NOTES = 25;

/** A caller-owned copy of the fixture vault. */
export async function fixtureVaultCopy(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "globnotes-mcp-vault-" });
  await copy(FIXTURE_VAULT, dir, { overwrite: true });
  return dir;
}

/** The local test domain and its address (client/tests/e2e/http-origin.mjs
 * rules: a dotted, non-loopback name resolving to one IPv4 address). Server
 * tests run without --allow-sys, so the "address of this machine" check is
 * the server's own bind to it, which fails for a foreign address. */
function testDomain(): { host: string; address: string } {
  return testOrigin({
    addresses: () => {
      const host = Deno.env.get("GLOBNOTES_TEST_HOST") ?? "";
      const output = command("getent", {
        args: ["ahostsv4", host],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      return new TextDecoder().decode(output.stdout).split("\n")
        .filter(Boolean).map((line) => line.split(/\s+/)[0]);
    },
  });
}

/** A server on `http://$GLOBNOTES_TEST_HOST:<port>`, never loopback. */
export function bootOnTestDomain(
  env: Record<string, unknown>,
): Promise<TestServer> {
  const { host, address } = testDomain();
  return bootServer({ GLOBNOTES__SERVER_PATHPREFIX: "", ...env }, {
    host: address,
    origin: (port) => `http://${host}:${port}`,
  });
}

/** An SDK client on the server's MCP endpoint. `modern` negotiates the
 * 2026-07-28 revision; the default is the 2025 initialize handshake. */
export async function connectMcp(
  server: TestServer,
  options: { modern?: boolean; token?: string } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${server.baseUrl}/_/mcp`),
    options.token === undefined
      ? {}
      : { authProvider: { token: () => Promise.resolve(options.token) } },
  );
  const client = new Client(
    { name: "globnotes-mcp-test", version: "1.0.0" },
    options.modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(transport);
  return client;
}
