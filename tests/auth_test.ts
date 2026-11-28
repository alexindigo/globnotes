// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { withFixtureDirectory } from "./helpers/fixture_layout.ts";
import { bootServer } from "./helpers/boot.ts";
import { createUuid } from "../shared/uuid.ts";
import { identityTokenScope } from "../shared/identity_token.ts";

for (const everybody of ["none", "view", "edit"] as const) {
  Deno.test(`first account HTTP: ${everybody} persists across restart and never grants guest Admin`, () =>
    withFixtureDirectory(async (root, scope) => {
      await Deno.writeTextFile(`${root}/Seed.md`, "first account note");
      const env = {
        GLOBNOTES_GLOBNOTES_PATH: root,
        GLOBNOTES__VAULTS_BASEPATH: root,
      };
      const boot = async () =>
        (await scope.acquire(() => bootServer(env), (server) => server.close()))
          .value;
      let server = await boot();
      async function api(
        path: string,
        method = "GET",
        body?: unknown,
        headers?: Record<string, string>,
      ) {
        const res = await fetch(`${server.baseUrl}/_/api/${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        const text = await res.text();
        return {
          status: res.status,
          body: text && JSON.parse(text),
          challenge: res.headers.get("www-authenticate"),
        };
      }
      assertEquals((await api("setup")).body, { setupRequired: true });
      const before = await api("config");
      assertEquals([
        before.status,
        before.body.setupRequired,
        before.body.principal,
        before.body.vaultId,
      ], [200, true, { kind: "guest" }, null]);
      const notReady = await api("notes/Seed");
      assertEquals([notReady.status, notReady.body], [503, {
        detail: "setup_required",
        code: "setup_required",
      }]);
      assertEquals((await api("health")).status, 200);
      assertEquals(
        (await api("token", "POST", { username: "x", password: "y" })).status,
        401,
      );
      const request = {
        username: "ALICE",
        password: "secret-password",
        everybody,
        updateId: createUuid(),
      };
      assertEquals(
        (await api("setup", "POST", { ...request, password: "" })).status,
        422,
      );
      const accountFile = `${root}/.globnotes/accounts.json`;
      await assertRejects(
        () => Deno.readTextFile(accountFile),
        Deno.errors.NotFound,
      );
      const setup = await api("setup", "POST", request);
      assertEquals([
        setup.status,
        setup.body.setupRequired,
        setup.body.everybody,
        setup.body.token_type,
      ], [200, false, everybody, "bearer"]);
      const bearer = { authorization: `Bearer ${setup.body.access_token}` };
      assertEquals((await api("setup", "POST", request)).status, 409);
      assertEquals((await api("setup/reset", "POST", {}, bearer)).status, 405);
      const accountBytes = await Deno.readTextFile(accountFile);
      const { accounts: [person] } = JSON.parse(accountBytes);
      assertEquals(person.login, "alice");
      assertMatch(person.passwordHash, /^pbkdf2_sha256\$/);
      assertEquals(accountBytes.includes(request.password), false);
      assertMatch(
        JSON.parse(await Deno.readTextFile(`${root}/.globnotes/sessions.json`))
          .signingKey,
        /^[a-f0-9]{64}$/,
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(`${root}/.globnotes/access.json`))
          .everybody,
        everybody,
      );
      if (everybody === "none") {
        assertEquals((await api("notes/Seed")).status, 403);
      } else {assertEquals(
          (await api("notes/Seed")).body.content,
          "first account note",
        );}
      assertEquals(
        (await api("notes", "POST", { path: "Guest", content: "guest note" }))
          .status,
        everybody === "edit" ? 200 : 403,
      );
      const refused = await api("access", "PUT", {});
      assertEquals([refused.status, refused.body], [403, {
        detail: "This account cannot perform that operation.",
        code: "operation_not_permitted",
      }]);
      assertEquals(
        (await api("notes/Seed", "GET", undefined, bearer)).body.content,
        "first account note",
      );
      const cookieName = identityTokenScope("").cookieName;
      const cookie = { cookie: `${cookieName}=${setup.body.access_token}` };
      assertEquals(
        (await api("notes/Seed", "GET", undefined, cookie)).body.content,
        "first account note",
      );
      const invalid = await api("token", "POST", {
        username: "alice",
        password: "bad",
      });
      assertEquals([invalid.status, invalid.body, invalid.challenge], [401, {
        detail: "Invalid authentication credentials.",
        code: "credentials_refused",
      }, "Bearer"]);
      await server.close();
      server = await boot();
      assertEquals((await api("setup")).body, { setupRequired: false });
      const again = await api("token", "POST", {
        username: "Alice",
        password: request.password,
      });
      assertEquals([again.status, again.body.token_type], [200, "bearer"]);
      const admin = await api("access", "GET", undefined, {
        authorization: `Bearer ${again.body.access_token}`,
      });
      assertEquals([admin.status, admin.body.everybody, admin.body.grants], [
        200,
        everybody,
        { [person.id]: "admin" },
      ]);
      assertEquals(await Deno.readTextFile(accountFile), accountBytes);
    }));
}
