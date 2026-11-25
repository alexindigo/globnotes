// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  AssertionError,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { fromFileUrl } from "@std/path";
import { HttpError, pathfinder } from "@pathfinder/pathfinder";
import {
  createHttpPolicy,
  HTTP_OPERATIONS,
  type HttpOperation,
} from "../server/auth/http_policy.ts";
import { identityHttpFixture } from "./helpers/identity_fixture.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { OwnershipError } from "../shared/ownership.js";

/** Review inventory, never a production policy lookup. */
const LEGACY_PUBLIC_EXCEPTIONS: Record<string, string> = {
  "get.ts": "SPA shell",
  "#...path/get.ts": "mixed shell/static/files; handler binds file authority",
  "_/login/get.ts": "SPA shell",
  "_/new/get.ts": "SPA shell",
  "_/search/get.ts": "SPA shell",
  "_/conflicts/get.ts": "SPA shell, no conflict data",
  "_/conflicts/#id/get.ts": "SPA shell, no conflict data",
  "_/api/health/get.ts": "health",
  "_/api/token/post.ts": "instance sign-in",
  "_/api/setup/get.ts": "minimal setup status",
  "_/api/setup/post.ts": "one-time setup",
  "_/api/setup/totp-enrolment/post.ts": "fresh setup enrollment",
  "_/api/config/get.ts": "legacy bridge; prepared session-aware projection",
  "_/api/index-status/get.ts": "legacy bridge; prepared View required",
  "_/brand/#...file/get.ts": "pre-login branding assets",
  "_/mcp/get.ts": "transport Origin and 405",
  "_/mcp/delete.ts": "transport Origin and 405",
  "_/mcp/post.ts": "transport per-tool authority",
};
const ROUTES: Record<HttpOperation, readonly string[]> = {
  public: [
    "get.ts",
    "_/login/get.ts",
    "_/new/get.ts",
    "_/search/get.ts",
    "_/conflicts/get.ts",
    "_/conflicts/#id/get.ts",
    "_/api/health/get.ts",
    "_/api/token/post.ts",
    "_/api/setup/get.ts",
    "_/api/setup/post.ts",
    "_/api/setup/totp-enrolment/post.ts",
    "_/brand/#...file/get.ts",
  ],
  shellOrFile: ["#...path/get.ts"],
  mcp: ["_/mcp/get.ts", "_/mcp/delete.ts", "_/mcp/post.ts"],
  session: ["_/api/auth-check/get.ts", "_/api/config/get.ts"],
  manageOwnAccount: [],
  createVault: [],
  readVault: [
    "_/api/changes/get.ts",
    "_/api/conflicts/get.ts",
    "_/api/conflicts/#id/get.ts",
    "_/api/files/#...path/get.ts",
    "_/api/index-status/get.ts",
    "_/api/note-index/get.ts",
    "_/api/notes/#...path/get.ts",
    "_/api/plugin-host/events/get.ts",
    "_/api/plugin-host/get.ts",
    "_/api/plugins/#id/get.ts",
    "_/api/plugins/#id/head.ts",
    "_/api/plugins/#id/options.ts",
    "_/api/plugins/#id/#...route/get.ts",
    "_/api/plugins/#id/#...route/head.ts",
    "_/api/plugins/#id/#...route/options.ts",
    "_/api/rename-preview/get.ts",
    "_/api/render/#...path/get.ts",
    "_/api/render/post.ts",
    "_/api/search/get.ts",
    "_/api/tags/get.ts",
    "_/api/tree/get.ts",
    "_/plugins.css/get.ts",
    "_/plugins/#id/app.js/get.ts",
    "_/plugins/#id/client.js/get.ts",
  ],
  editNotes: [
    "_/api/conflicts/#id/resolve/post.ts",
    "_/api/files/post.ts",
    "_/api/files/rewrite-refs/post.ts",
    "_/api/notes/#...path/delete.ts",
    "_/api/notes/#...path/patch.ts",
    "_/api/notes/post.ts",
    "_/api/plugin-host/#id/commands/#command/post.ts",
    "_/api/plugins/#id/delete.ts",
    "_/api/plugins/#id/patch.ts",
    "_/api/plugins/#id/post.ts",
    "_/api/plugins/#id/put.ts",
    "_/api/plugins/#id/#...route/delete.ts",
    "_/api/plugins/#id/#...route/patch.ts",
    "_/api/plugins/#id/#...route/post.ts",
    "_/api/plugins/#id/#...route/put.ts",
  ],
  manageVault: [
    "_/api/access/get.ts",
    "_/api/access/put.ts",
    "_/api/access/totp-enrolment/post.ts",
    "_/api/brand/post.ts",
    "_/api/drivers/get.ts",
    "_/api/drivers/#id/decisions/post.ts",
    "_/api/drivers/#id/delete.ts",
    "_/api/drivers/#id/put.ts",
    "_/api/drivers/#id/secrets/#key/delete.ts",
    "_/api/drivers/#id/secrets/#key/put.ts",
    "_/api/drivers/#id/sync/post.ts",
    "_/api/drivers/post.ts",
    "_/api/plugin-host/#id/enabled/put.ts",
    "_/api/plugin-host/#id/permission-requests/#request/decision/post.ts",
    "_/api/plugin-host/#id/permissions/get.ts",
    "_/api/plugin-host/#id/permissions/put.ts",
    "_/api/plugin-host/#id/settings/#page/get.ts",
    "_/api/plugin-host/#id/settings/#page/put.ts",
    "_/api/plugin-host/permission-requests/get.ts",
    "_/api/plugin-host/policy/put.ts",
    "_/api/plugins/get.ts",
    "_/api/setup/reset/post.ts",
  ],
};
const EXPECTED = Object.fromEntries(
  Object.entries(ROUTES).flatMap(([operation, routes]) =>
    routes.map((route) => [route, operation])
  ),
);

function classified(file: string, source: string) {
  const operation = /export const operation = "([A-Za-z]+)";/.exec(source)?.[1];
  assert(
    HTTP_OPERATIONS.includes(operation as typeof HTTP_OPERATIONS[number]),
    `Unclassified: ${file}`,
  );
  assertEquals(operation, EXPECTED[file], `Wrong operation: ${file}`);
  return operation!;
}

Deno.test("identity route policy: all discovered endpoints declare operations and exact public exceptions", () => {
  const root = fromFileUrl(
    new URL("../server/api/endpoints/", import.meta.url),
  );
  const seen: string[] = [], operations: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of Deno.readDirSync(`${root}${directory}`)) {
      const file = `${directory}${entry.name}`;
      if (entry.isDirectory) visit(`${file}/`);
      else if (file.endsWith(".ts") && file !== "_/00-auth.ts") {
        const source = Deno.readTextFileSync(`${root}${file}`);
        operations[file] = classified(file, source);
        if (/export const auth = false/.test(source)) seen.push(file);
      }
    }
  };
  visit("");
  assertEquals(seen.sort(), Object.keys(LEGACY_PUBLIC_EXCEPTIONS).sort());
  assertEquals(operations, EXPECTED);
  assertThrows(
    () => classified("new/get.ts", "export default () => 'unguarded';"),
    AssertionError,
    "Unclassified: new/get.ts",
  );
  for (const bypass of ["public", "shellOrFile", "mcp"]) {
    assertThrows(
      () =>
        classified(
          "_/api/notes/#...path/get.ts",
          `export const operation = "${bypass}";`,
        ),
      AssertionError,
      "Wrong operation: _/api/notes/#...path/get.ts",
    );
  }
});

Deno.test("identity route policy: operation and concrete target, never method, determine access", () =>
  identityHttpFixture(async (f) => {
    const policy = createHttpPolicy(f.auth);
    const req = (method: string, target = "") =>
      new Request(`http://globnotes.test/instance/_/api/render${target}`, {
        method,
        headers: f.request().headers,
      });
    assertEquals(
      (await policy.admit(req("POST"), "readVault"))?.operation,
      "readVault",
    );
    for (const operation of ["manageVault", "editNotes"]) {
      const error = await assertRejects(
        () => policy.admit(req("GET"), operation),
        HttpError,
        "HTTP 403",
      );
      assertEquals(error.detail, "This account cannot perform that operation.");
    }
    const missing = await assertRejects(
      () => policy.admit(req("GET"), undefined),
      HttpError,
      "HTTP 403",
    );
    assertEquals(missing.detail, "Endpoint access requirement is missing.");
    for (const target of ["?vault=other", "?vault=globnotes&vault=other"]) {
      const error = await assertRejects(
        () => policy.admit(req("GET", target), "readVault"),
        HttpError,
        "HTTP 400",
      );
      assertEquals(error.detail, "Unsupported vault target.");
    }
    assertEquals(
      (await policy.admit(req("HEAD", "?vault=globnotes"), "readVault"))
        ?.operation,
      "readVault",
    );
    f.policy("none");
    assertEquals(
      (await policy.admit(req("PATCH", "?vault=other"), "manageOwnAccount"))
        ?.operation,
      "manageOwnAccount",
    );
    const status = await policy.json(
      new Request("http://globnotes.test/status?vault=other"),
      "session",
      () => Promise.resolve({ guest: true }),
    );
    assertEquals(await status.json(), { guest: true });
    const pending = await policy.json(
      req("GET", "?vault=other"),
      "session",
      () => Promise.resolve({ login: "bob" }),
    );
    f.lifetime.retire();
    await assertRejects(
      () => pending.json(),
      OwnershipError,
      "Owner is retired",
    );
  }));

Deno.test("identity route policy: real Pathfinder metadata admits before handler and refuses late private response", () =>
  identityHttpFixture(async (f) => {
    const root = `${f.root}/routes`;
    for (const name of ["read", "admin", "unclassified"]) {
      Deno.mkdirSync(`${root}/${name}`, { recursive: true });
    }
    const middleware =
      new URL("../server/api/endpoints/_/00-auth.ts", import.meta.url).href;
    Deno.writeTextFileSync(
      `${root}/00-auth.ts`,
      `import {createIdentityAuthMiddleware} from ${
        JSON.stringify(middleware)
      }; export default (request,context)=>createIdentityAuthMiddleware(context.app.auth)(request,context);`,
    );
    Deno.writeTextFileSync(
      `${root}/read/post.ts`,
      `export const operation='readVault'; export default async (_request,context)=>{if(!context.state.identityLease)throw new Error('lease missing');await context.app.hold();return {privateNote:'secret'};};`,
    );
    Deno.writeTextFileSync(
      `${root}/admin/get.ts`,
      `export const operation='manageVault'; export default ()=>({secretSettings:true});`,
    );
    Deno.writeTextFileSync(
      `${root}/unclassified/get.ts`,
      `export default ()=>({unguarded:true});`,
    );
    const appData = { auth: f.auth, hold: () => Promise.resolve() };
    const app = await pathfinder({ roots: [root], app: appData });
    const request = (path: string, method = "GET") =>
      new Request(`http://globnotes.test/${path}`, {
        method,
        headers: f.request().headers,
      });
    const denials = [];
    for (const path of ["admin", "unclassified"]) {
      const denied = await app(request(path));
      denials.push([denied.status, await denied.json()]);
    }
    assertEquals(denials, [
      [403, { detail: "This account cannot perform that operation." }],
      [403, { detail: "Endpoint access requirement is missing." }],
    ]);
    await heldOperation({
      label: "Pathfinder read handler",
      progress: { kind: "controlled", clock: "external" },
      owner: () => f.auth,
      signal: f.scope.signal,
    }, (hold) => {
      appData.hold = hold;
      return app(request("read", "POST"));
    }, async (operation) => {
      await operation.reached();
      f.policy("none");
      const denied = await operation.result();
      assertEquals(denied.status, 409);
      assertEquals(await denied.json(), {
        code: "operation_conflict",
        detail:
          "Access policy changed while this operation was pending; it was not applied.",
      });
    });
    appData.hold = () => Promise.resolve();
    f.policy("view");
    const allowed = await app(request("read", "POST"));
    assertEquals([allowed.status, await allowed.json()], [200, {
      privateNote: "secret",
    }]);
  }));
