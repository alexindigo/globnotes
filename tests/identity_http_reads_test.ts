// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  HttpError,
  pathfinder,
  type PathfinderRequest,
} from "@pathfinder/pathfinder";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createHttpPolicy,
  protectVaultResponse,
  replacePrivateResponse,
} from "../server/auth/http_policy.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { createIdentityFileGet } from "../server/api/endpoints/_/api/files/%23...path/get.ts";
import { createIdentityCatchAll as routeCatchAll } from "../server/api/endpoints/%23...path/get.ts";
import { createIdentityCatchAll } from "../server/catchall.ts";
import render from "../server/api/endpoints/_/api/render/post.ts";
import { OperationError } from "../server/plugins/errors.ts";
import {
  createMcpEndpoint,
  identityMcpCaller,
} from "../server/mcp/endpoint.ts";
import { stateVault } from "../server/mcp/vault.ts";
import { READ_ONLY_MESSAGE } from "../server/mcp/errors.ts";
import { createRateLimiter } from "../server/mcp/rate_limit.ts";
import { state } from "../server/state.ts";
import {
  identityHttpFixture,
  seedIdentityRecords,
} from "./helpers/identity_fixture.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { identityFixture, VAULT_A } from "./helpers/identity.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { signIn } from "./helpers/session_delivery.ts";

Deno.test("identity HTTP writes: PATCH keeps a committed merged save but fences its note at delivery", () =>
  identityHttpFixture(async (f) => {
    const hub = (await f.scope.acquire(hubOperationsFixture, (h) =>
      h.close())).value;
    const routes = `${f.root}/routes`;
    Deno.mkdirSync(`${routes}/#...path`, { recursive: true });
    const auth =
      new URL("../server/api/endpoints/_/00-auth.ts", import.meta.url).href;
    Deno.writeTextFileSync(
      `${routes}/00-auth.ts`,
      `import { createIdentityAuthMiddleware } from ${
        JSON.stringify(auth)
      }; export default (request, context) => createIdentityAuthMiddleware(context.app.auth)(request, context);`,
    );
    const patch = new URL(
      "../server/api/endpoints/_/api/notes/%23...path/patch.ts",
      import.meta.url,
    ).href;
    Deno.writeTextFileSync(
      `${routes}/#...path/patch.ts`,
      `export { default, operation } from ${JSON.stringify(patch)};`,
    );
    const app = await pathfinder({ roots: [routes], app: { auth: f.auth } });
    f.policy("edit");
    const save = (baseContent: string, newContent: string) =>
      app(
        new Request("http://globnotes.test/Proof", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: f.request().headers.get("cookie")!,
          },
          body: JSON.stringify({ baseContent, newContent }),
        }),
      );
    const base = "left\n\nmiddle\n\nright\n";
    const peer = "left\n\nmiddle\n\nprivate peer edit\n";
    await hub.operations.createNote(
      { path: "Proof", content: base },
      hub.api(),
    );
    const current = await save(base, peer);
    assertEquals((await current.json()).content, peer);
    const committed = await save(base, "editor edit\n\nmiddle\n\nright\n");
    assertEquals(
      Deno.readTextFileSync(`${hub.vault}/Proof.md`),
      "editor edit\n\nmiddle\n\nprivate peer edit\n",
    );
    f.policy("none");
    assertEquals([committed.status, await committed.json()], [200, {
      committed: true,
      saveResult: { status: "merged" },
    }]);
  }));

function view(request: Request, path: string): PathfinderRequest {
  return {
    _raw: request,
    path,
    method: request.method,
    headers: request.headers,
    query: new URL(request.url).searchParams,
    params: {},
    body: { text: () => request.text() },
  } as PathfinderRequest;
}

for (const consume of ["read", "cancel"] as const) {
  Deno.test(`identity HTTP reads: ${consume} refusal owns private cancellation only after Pathfinder post phase`, () =>
    fixtureScope(async (scope) => {
      const events: string[] = [];
      const gate = fixtureGate(scope);
      const original = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            events.push("cancel");
            return gate.promise;
          },
        }, { highWaterMark: 0 }),
      );
      const replacement = await replacePrivateResponse(
        original,
        Response.json({ detail: "denied" }, { status: 403 }),
      );
      assertEquals([original.bodyUsed, events], [false, []]);
      try {
        if (consume === "read") {
          assertEquals(
            await bounded(
              replacement.json(),
              "safe refusal despite pending source cancellation",
            ),
            { detail: "denied" },
          );
        } else {await bounded(
            replacement.body!.cancel(),
            "safe refusal cancellation",
          );}
        assertEquals([original.bodyUsed, events], [true, ["cancel"]]);
      } finally {
        gate.resolve();
        await gate.promise;
      }
    }));
}

Deno.test("identity HTTP reads: direct/API/cookie/prefix/HEAD/range agree; bad bearer and None disclose nothing", () =>
  identityHttpFixture(async (f) => {
    const notes = `${f.root}/notes`;
    Deno.mkdirSync(notes);
    Deno.writeTextFileSync(`${notes}/attachment.txt`, "private attachment");
    const files = new FileServing(notes),
      get = createIdentityFileGet(f.auth, files);
    const navigation = (headers: Record<string, string>) =>
      f.request("GET", {
        cookie: f.request().headers.get("cookie")!,
        ...headers,
      });
    assertStrictEquals(routeCatchAll, createIdentityCatchAll);
    const direct = routeCatchAll(
      f.auth,
      files,
      () => new Response("public shell"),
    );
    assertEquals(
      await (await get(f.request(), "attachment.txt")).text(),
      "private attachment",
    );
    assertEquals(
      await (await direct(view(f.request(), "/attachment.txt"))).text(),
      "private attachment",
    );
    assertEquals((await get(f.request("HEAD"), "attachment.txt")).body, null);
    // The existing serving contract returns whole bytes, not partial ranges.
    assertEquals(
      await (await get(
        f.request("GET", {
          cookie: f.request().headers.get("cookie")!,
          range: "bytes=0-3",
        }),
        "attachment.txt",
      )).text(),
      "private attachment",
    );
    const invalid = await assertRejects(
      () =>
        get(
          f.request("GET", {
            cookie: f.request().headers.get("cookie")!,
            authorization: "Bearer bad",
          }),
          "attachment.txt",
        ),
      HttpError,
      "HTTP 401",
    );
    assertEquals(invalid.status, 401);
    f.policy("none");
    const errors: number[] = [];
    for (const method of ["GET", "HEAD"]) {
      errors.push(
        (await assertRejects(
          () => get(f.request(method), "attachment.txt"),
          HttpError,
          "HTTP 403",
        )).status,
      );
      errors.push(
        (await assertRejects(
          () => direct(view(f.request(method), "/attachment.txt")),
          HttpError,
          "HTTP 403",
        )).status,
      );
    }
    assertEquals(errors, [403, 403, 403, 403]);
    for (
      const headers of [
        { "sec-fetch-mode": "navigate" },
        { "sec-fetch-dest": "document" },
        { accept: "text/html,application/xhtml+xml" },
      ] as Record<string, string>[]
    ) {
      for (const title of ["/a-note", "/a/v2.1", "/attachment.txt"]) {
        const shell = await direct(view(navigation(headers), title));
        assertEquals([shell.status, await shell.text()], [200, "public shell"]);
      }
    }
    const denials = [];
    for (const path of ["/attachment.txt", "/missing.txt"]) {
      const error = await assertRejects(
        () =>
          direct(
            view(
              navigation({ "sec-fetch-mode": "cors", accept: "text/html" }),
              path,
            ),
          ),
        HttpError,
        "HTTP 403",
      );
      denials.push([error.status, error.detail, error.headers]);
    }
    assertEquals(denials[0], denials[1]);
    assertEquals(
      Deno.readTextFileSync(`${notes}/attachment.txt`),
      "private attachment",
    );
  }));

Deno.test("identity HTTP reads: actual file read and lazy body delivery recheck revocation", () =>
  identityHttpFixture(async (f) => {
    Deno.mkdirSync(`${f.root}/notes`);
    Deno.writeTextFileSync(
      `${f.root}/notes/attachment.txt`,
      "private attachment",
    );
    const get = createIdentityFileGet(
      f.auth,
      new FileServing(`${f.root}/notes`),
    );
    const read = Deno.readFileSync;
    const events: string[] = [];
    Deno.readFileSync = (path) => {
      const bytes = read(path);
      if (String(path).endsWith("attachment.txt")) {
        events.push("read");
        f.policy("none");
      }
      return bytes;
    };
    try {
      await assertRejects(
        () => get(f.request(), "attachment.txt"),
        OperationError,
        "Access policy changed while this operation was pending; it was not applied.",
      );
    } finally {
      Deno.readFileSync = read;
    }
    assertEquals(events, ["read"]);
    f.policy("view");
    const current = await get(f.request(), "attachment.txt");
    assertEquals(await current.text(), "private attachment");
    const queued = await get(f.request(), "attachment.txt");
    f.policy("none");
    await assertRejects(
      () => queued.text(),
      OperationError,
      "Access policy changed while this operation was pending; it was not applied.",
    );
  }));

Deno.test("identity HTTP reads: bodyless, conditional and range responses share the final fence", () =>
  identityHttpFixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    for (const status of [200, 204, 206, 304]) {
      const bodyless = status === 204 || status === 304;
      const response = protectVaultResponse(
        lease,
        new Response(bodyless ? null : "bytes", { status }),
      );
      assertEquals([response.status, await response.text()], [
        status,
        bodyless ? "" : "bytes",
      ]);
    }
    f.policy("none");
    const errors: string[] = [];
    for (const status of [200, 204, 206, 304]) {
      const error = assertThrows(
        () =>
          protectVaultResponse(
            lease,
            new Response(status === 204 || status === 304 ? null : "bytes", {
              status,
            }),
          ),
        OperationError,
        "Access policy changed while this operation was pending; it was not applied.",
      );
      errors.push(error.code);
    }
    assertEquals(errors, [
      "operation_conflict",
      "operation_conflict",
      "operation_conflict",
      "operation_conflict",
    ]);
  }));

Deno.test("identity HTTP reads: exact streamed chunks stop after revocation and cancel the source once", () =>
  identityHttpFixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    const sourceEvents: string[] = [], chunks: string[] = [];
    const response = protectVaultResponse(
      lease,
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sourceEvents.push("pull");
            controller.enqueue(new TextEncoder().encode("first"));
          },
          cancel() {
            sourceEvents.push("cancel");
          },
        }, { highWaterMark: 0 }),
      ),
    );
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      chunks.push(new TextDecoder().decode(first.value));
      f.policy("none");
      const error = await assertRejects(
        () => reader.read(),
        OperationError,
        "Access policy changed while this operation was pending; it was not applied.",
      );
      assertEquals([chunks, sourceEvents, error.code], [["first"], [
        "pull",
        "cancel",
      ], "operation_conflict"]);
    } finally {
      reader.releaseLock();
    }
  }));

Deno.test("identity HTTP reads: View POST render succeeds; held render and prepared JSON cannot disclose stale values", () =>
  identityHttpFixture(async (f) => {
    const policy = createHttpPolicy(f.auth), previous = state.plugins;
    state.plugins = null;
    try {
      const request = new Request(
        "http://globnotes.test/instance/_/api/render",
        {
          method: "POST",
          body: "# Reader preview",
          headers: f.request().headers,
        },
      );
      const response = await policy.read(
        request,
        "readVault",
        () => render(view(request, "/_/api/render")),
      );
      assertEquals(
        await response.text(),
        '<h1 data-source-line="0" data-line="L1" id="reader-preview">Reader preview</h1>\n',
      );
      await heldOperation({
        label: "render response",
        progress: { kind: "controlled", clock: "external" },
        owner: () => f.auth,
        signal: f.scope.signal,
      }, (hold) =>
        policy.read(f.request(), "readVault", async () => {
          await hold();
          return Response.json({ privateResult: true });
        }), async (operation) => {
        await operation.reached();
        f.policy("none");
        await assertRejects(
          () => operation.result(),
          OperationError,
          "Access policy changed while this operation was pending; it was not applied.",
        );
      });
      f.policy("view");
      const pending = await policy.json(
        f.request(),
        "readVault",
        () => Promise.resolve({ note: "private" }),
      );
      f.policy("none");
      await assertRejects(
        () => pending.json(),
        OperationError,
        "Access policy changed while this operation was pending; it was not applied.",
      );
    } finally {
      state.plugins = previous;
    }
  }));

for (const modern of [false, true]) {
  Deno.test(`identity MCP: ${modern ? "modern" : "legacy"} caller-qualified tools retain View, write denial, Origin and stale-base guards`, () =>
    fixtureScope(async (scope) => {
      const hub = (await scope.acquire(() =>
        hubOperationsFixture(), (hub) =>
        hub.close())).value;
      await identityHttpFixture(async (f) => {
        const tools: string[] = [], caller = identityMcpCaller(f.auth);
        let writable = true;
        const endpoint = (await scope.acquire(() =>
          createMcpEndpoint({
            vault: stateVault,
            writable: () =>
              writable,
            version: () =>
              "test",
            rateLimiter: null,
            callerAccess: async (request) => {
              const access = await caller(request);
              return {
                ...access,
                operationLease: (operation) => {
                  tools.push(operation);
                  return access.operationLease(operation);
                },
              };
            },
          }), (endpoint) => endpoint.close())).value;
        const connect = async (token: string) => {
          const client = (await scope.acquire(() =>
            new Client(
              { name: "identity-proof", version: "1" },
              modern ? { versionNegotiation: { mode: "auto" } } : {},
            ), (client) => client.close())).value;
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL("http://globnotes.test/_/mcp"),
              {
                fetch: (url, init) => {
                  const request = new Request(url, init);
                  request.headers.set("authorization", `Bearer ${token}`);
                  return request.method === "POST"
                    ? endpoint.post(request)
                    : Promise.resolve(endpoint.notAllowed(request));
                },
              },
            ),
          );
          return client;
        };
        await hub.operations.createNote({
          path: "Proof",
          content: "stored proof",
        }, hub.api());
        const viewer = await connect(f.signed.access_token);
        assertEquals(viewer.getProtocolEra(), modern ? "modern" : "legacy");
        assertEquals(
          (await viewer.listTools()).tools.map((tool) => tool.name),
          [
            "globnotes_search_notes",
            "globnotes_get_note",
            "globnotes_list_folder",
            "globnotes_list_tags",
          ],
        );
        const result = await viewer.callTool({
          name: "globnotes_get_note",
          arguments: { path: "Proof" },
        });
        assertEquals([
          result.isError,
          (result.structuredContent as { content: string }).content,
        ], [undefined, "stored proof"]);
        const denied = await viewer.callTool({
          name: "globnotes_create_note",
          arguments: { path: "Forbidden", content: "bad" },
        });
        assertEquals([denied.isError, denied.content], [true, [{
          type: "text",
          text: READ_ONLY_MESSAGE,
        }]]);
        assertThrows(
          () => Deno.statSync(`${hub.vault}/Forbidden.md`),
          Deno.errors.NotFound,
          "No such file or directory",
        );
        const alice = await signIn(f.sessions, {
          username: "alice",
          password: "password",
        });
        const admin = await connect(alice.access_token);
        assertEquals(
          (await admin.listTools()).tools.map((tool) => tool.name),
          [
            "globnotes_search_notes",
            "globnotes_get_note",
            "globnotes_list_folder",
            "globnotes_list_tags",
            "globnotes_create_note",
            "globnotes_update_note",
            "globnotes_delete_note",
          ],
        );
        const stale = await admin.callTool({
          name: "globnotes_update_note",
          arguments: {
            path: "Proof",
            content: "overwrite",
            expected_hash: "00".repeat(32),
          },
        });
        assertEquals([stale.isError, stale.content], [true, [{
          type: "text",
          text: "Note 'Proof' changed since you read it (expected hash " +
            `${"00".repeat(32)}, now ` +
            "907c53c8715ef661a1b98f1cbc1175e09bb4a1c51ef299bec5644b6f9bcc61d5)" +
            ". Nothing was written. Call globnotes_get_note to re-read it, " +
            "then retry with the new hash.",
        }]]);
        assertEquals(
          Deno.readTextFileSync(`${hub.vault}/Proof.md`),
          "stored proof",
        );
        assertEquals(tools, ["readVault", "editNotes", "editNotes"]);
        writable = false;
        assertEquals((await admin.listTools()).tools.map((tool) => tool.name), [
          "globnotes_search_notes",
          "globnotes_get_note",
          "globnotes_list_folder",
          "globnotes_list_tags",
        ]);
        const blocked = await admin.callTool({
          name: "globnotes_create_note",
          arguments: { path: "Blocked", content: "deployment is read only" },
        });
        assertEquals([blocked.isError, blocked.content], [true, [{
          type: "text",
          text: READ_ONLY_MESSAGE,
        }]]);
        assertThrows(
          () => Deno.statSync(`${hub.vault}/Blocked.md`),
          Deno.errors.NotFound,
        );
        assertEquals(tools, ["readVault", "editNotes", "editNotes"]);
        const foreign = await endpoint.post(
          new Request("http://globnotes.test/_/mcp", {
            method: "POST",
            headers: { origin: "http://foreign.test" },
          }),
        );
        assertEquals([foreign.status, await foreign.json()], [403, {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Forbidden: Origin does not match Host",
          },
          id: null,
        }]);
      });
    }));
}

Deno.test("identity MCP: caller-specific read path retains rate limiting", () =>
  identityHttpFixture(async (f) => {
    const endpoint = (await f.scope.acquire(() =>
      createMcpEndpoint({
        callerAccess: identityMcpCaller(f.auth),
        writable: () => true,
        rateLimiter: createRateLimiter({
          perMinute: 1,
          now: () => 0,
        }),
      }), (endpoint) => endpoint.close())).value;
    const response = await endpoint.post(
      new Request("http://globnotes.test/_/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${f.signed.access_token}`,
        },
        body: JSON.stringify(
          [1, 2].map((id) => ({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "globnotes_list_tags" },
          })),
        ),
      }),
    );
    assertEquals([response.status, response.headers.get("retry-after")], [
      429,
      "1",
    ]);
    assertEquals(await response.json(), {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Too many tool calls: this globnotes server allows 1 per minute per client and this request makes 2. Retry after 1 seconds.",
      },
      id: null,
    });
  }));

Deno.test("identity MCP: a legacy batch with mixed outcomes discloses only the committed receipt after revocation", () =>
  fixtureScope(async (scope) => {
    const hub = (await scope.acquire(() =>
      hubOperationsFixture(), (hub) => hub.close())).value;
    await identityHttpFixture(async (f) => {
      const endpoint = (await scope.acquire(() =>
        createMcpEndpoint({
          vault: stateVault,
          writable: () =>
            true,
          version: () => "test",
          rateLimiter: null,
          callerAccess: identityMcpCaller(f.auth),
        }), (endpoint) => endpoint.close())).value;
      await hub.operations.createNote({
        path: "Proof",
        content: "stored proof",
      }, hub.api());
      f.policy("edit");
      const call = (id: number, name: string, args: unknown) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const batch = await endpoint.post(
        new Request("http://globnotes.test/_/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-03-26",
            authorization: `Bearer ${f.signed.access_token}`,
          },
          body: JSON.stringify([
            call(1, "globnotes_get_note", { path: "Proof" }),
            call(2, "globnotes_create_note", {
              path: "Created",
              content: "written",
            }),
            call(3, "globnotes_update_note", {
              path: "Proof",
              content: "overwrite",
              expected_hash: "00".repeat(32),
            }),
          ]),
        }),
      );
      assertEquals(batch.status, 200);
      // All tool replies were produced; the HTTP body has not been consumed.
      f.policy("none");
      const replies = await batch
        .json() as (Record<string, unknown> & { id: number })[];
      assertEquals(replies.sort((a, b) => a.id - b.id), [
        {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "Access ended before reply delivery.",
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{
              type: "text",
              text: 'Write committed.\n{"committed":true}',
            }],
            structuredContent: { committed: true },
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          error: {
            code: -32000,
            message: "Access ended before reply delivery.",
          },
        },
      ]);
      assertEquals(
        Deno.readTextFileSync(`${hub.vault}/Created.md`),
        "written",
      );
      assertEquals(
        Deno.readTextFileSync(`${hub.vault}/Proof.md`),
        "stored proof",
      );
    });
  }));

Deno.test("identity fixture producer: explicit account/ACL inputs persist without legacy auth vocabulary", () =>
  identityFixture(async (root, scope) => {
    const records = await seedIdentityRecords({
      scope,
      instancePath: `${root}/instance`,
      vaultPath: `${root}/metadata`,
      vaultId: VAULT_A,
      people: [{ login: "alice", password: "password" }, {
        login: "recipient",
        password: "temporary",
        temporary: true,
      }],
      everybody: "edit",
      grants: { alice: "admin", recipient: "none" },
    });
    const restarted = new AccountRepository(`${root}/instance`);
    scope.onCancel(() => restarted.retireCredentials());
    assertEquals(restarted.byLogin("recipient")?.passwordChangeRequired, true);
    assertEquals(
      records.acl.capture().value.grants[restarted.byLogin("recipient")!.id],
      "none",
    );
    assertEquals(records.accounts.initialized, true);
    assertEquals(records.signing.capture().persistence.raw === null, false);
  }));

Deno.test("identity fixture producer: refuses an existing ACL before creating credentials", () =>
  identityFixture(async (root, scope) => {
    const input = {
      scope,
      instancePath: `${root}/first`,
      vaultPath: `${root}/metadata`,
      vaultId: VAULT_A,
      people: [{ login: "alice", password: "password" }],
      everybody: "none" as const,
      grants: { alice: "admin" as const },
    };
    await seedIdentityRecords(input);
    const aclPath = `${input.vaultPath}/access.json`;
    const original = Deno.readFileSync(aclPath);
    const second = `${root}/second`;
    await assertRejects(
      () => seedIdentityRecords({ ...input, instancePath: second }),
      Error,
      "Identity fixture requires a fresh ACL.",
    );
    assertEquals(Deno.readFileSync(aclPath), original);
    assertThrows(() => Deno.statSync(second), Deno.errors.NotFound);
  }));
