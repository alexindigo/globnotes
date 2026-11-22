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
} from "../server/auth/http_policy.ts";
import { identityHttpFixture } from "./helpers/identity_fixture.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { OwnershipError } from "../shared/ownership.js";

/** Review inventory, never a production policy lookup. */
const PUBLIC_EXCEPTIONS: Record<string, string> = {
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
  "_/brand/#...file/get.ts": "legacy bridge; prepared View required",
  "_/mcp/get.ts": "transport Origin and 405",
  "_/mcp/delete.ts": "transport Origin and 405",
  "_/mcp/post.ts": "transport per-tool authority",
};
function classified(file: string, source: string) {
  const operation = /export const operation = "([A-Za-z]+)";/.exec(source)?.[1];
  assert(
    HTTP_OPERATIONS.includes(operation as typeof HTTP_OPERATIONS[number]),
    `Unclassified: ${file}`,
  );
  if (/export const auth = false/.test(source) || operation === "public") {
    assert(
      Object.hasOwn(PUBLIC_EXCEPTIONS, file),
      `Unexpected public route: ${file}`,
    );
  }
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
  assertEquals(seen.sort(), Object.keys(PUBLIC_EXCEPTIONS).sort());
  assertEquals(Object.keys(operations).length, 79);
  for (
    const [file, expected] of [
      ["_/api/access/get.ts", "manageVault"],
      ["_/api/drivers/get.ts", "manageVault"],
      ["_/api/plugin-host/#id/settings/#page/get.ts", "manageVault"],
      ["_/api/plugin-host/#id/permissions/get.ts", "manageVault"],
      ["_/api/plugins/get.ts", "manageVault"],
      ["_/api/render/post.ts", "readVault"],
      ["_/api/conflicts/#id/resolve/post.ts", "editNotes"],
      ["_/api/files/#...path/get.ts", "readVault"],
      ["_/api/auth-check/get.ts", "session"],
      ["#...path/get.ts", "shellOrFile"],
    ]
  ) assertEquals(operations[file], expected);
  assertThrows(
    () => classified("new/get.ts", "export default () => 'unguarded';"),
    AssertionError,
    "Unclassified: new/get.ts",
  );
  assertThrows(
    () =>
      classified(
        "new/get.ts",
        'export const operation = "public"; export const auth = false;',
      ),
    AssertionError,
    "Unexpected public route: new/get.ts",
  );
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
