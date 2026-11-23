// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import {
  identityCookie,
  identityTokenScope,
} from "../shared/identity_token.ts";
import { createInstanceAuth } from "../server/auth/middleware.ts";
import { createIdentityComposition } from "../server/auth/composition.ts";
import { identityHttpFixture } from "./helpers/identity_fixture.ts";
import { withIdentityComposition } from "./helpers/identity_scope.ts";
import { GlobalConfig } from "../server/config.ts";

Deno.test("identity cookie: I08 authentication isolates two prefixes and rejects malformed supplied credentials", () =>
  identityHttpFixture(async (f) => {
    const scopes = [identityTokenScope("/one"), identityTokenScope("/two")];
    const adapters = scopes.map((scope) =>
      createInstanceAuth({
        sessions: f.sessions,
        vault: () => f.vault,
        cookieName: scope.cookieName,
        lifetime: () => f.lifetime.lease,
      })
    );
    const cookie = identityCookie(
      scopes[0].cookieName,
      f.signed.access_token,
      scopes[0].path,
    );
    const request = (headers: HeadersInit) =>
      new Request("http://globnotes.test/one/_/api/auth/check", { headers });
    assertEquals([
      (await adapters[0].principal(request({ cookie }))).kind,
      (await adapters[1].principal(request({ cookie }))).kind,
      (await adapters[0].principal(
        request({ cookie: `token=${f.signed.access_token}` }),
      )).kind,
    ], ["account", "guest", "guest"]);
    const malformed: HeadersInit[] = [
      { cookie: `${cookie}; ${cookie}` },
      { cookie: scopes[0].cookieName },
      { cookie: `${cookie}; ${scopes[0].cookieName}` },
      { cookie: `${scopes[0].cookieName}=%xx` },
      { cookie, authorization: "Bearer invalid" },
    ];
    for (const headers of malformed) {
      const error = await assertRejects(
        () => adapters[0].principal(request(headers)),
        HttpError,
        "HTTP 401",
      );
      assertEquals(error.status, 401);
    }
    // Browser logout is not a server-side token revocation operation.
    assertEquals(
      (await f.sessions.resolve(f.signed.access_token)).kind,
      "account",
    );
  }));

Deno.test("identity cookie: I10 composition derives the shared prefix name and delivers the actual safe projection", () =>
  withIdentityComposition(async (f) => {
    const scope = identityTokenScope("/one");
    const resolved = f.operations.config.resolved;
    const config = new GlobalConfig({
      ...resolved,
      instance: {
        ...resolved.instance,
        server: { ...resolved.instance.server, pathprefix: "/one" },
      },
    });
    const composition = createIdentityComposition({
      sessions: f.sessions,
      acl: f.acl,
      vaultId: f.composition.vault.id,
      config,
      lifecycle: f.operations.lifecycle,
      lifetime: f.lifetime.lease,
      plugins: () => f.operations.manager,
      setupStatus: () => ({ setupRequired: false }),
      release: { version: "fixture", revision: "fixture-revision" },
    });
    const request = (cookie: string) =>
      new Request("http://globnotes.test/one/_/api/config", {
        headers: { cookie },
      });
    const body = await (await composition.responses.config(
      request(
        identityCookie(scope.cookieName, f.token.access_token, scope.path),
      ),
    )).json();
    assertEquals([
      body.accountId,
      body.principal.login,
      body.vaultId,
      body.capabilities.canRead,
      body.capabilities.canManageVault,
    ], [f.alice.id, "alice", composition.vault.id, true, true]);
    const guest = await (await composition.responses.config(
      request(
        identityCookie(
          identityTokenScope("/two").cookieName,
          f.token.access_token,
          "/two",
        ),
      ),
    )).json();
    assertEquals([
      guest.accountId,
      guest.principal,
      guest.capabilities.canManageVault,
    ], [null, { kind: "guest" }, false]);
  }));
