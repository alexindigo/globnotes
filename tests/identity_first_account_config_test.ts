// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ConfigError, loadInstanceConfig } from "../server/config/loader.ts";
import { IdentityRecoveryError } from "../server/auth/bootstrap.ts";
import { identityFixture, UPDATE } from "./helpers/identity.ts";
import { bootstrapContext } from "./helpers/identity_bootstrap.ts";
import { resetFixturePassword } from "./helpers/account_preparation.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { AuthenticationError } from "../server/auth/account_credentials.ts";

Deno.test("first account configuration: exact paired leaves retain normal precedence and secret-free provenance", () =>
  identityFixture((root) => {
    const file = `${root}/instance.toml`;
    Deno.writeTextFileSync(
      file,
      '[accounts.first]\nlogin=" Bob "\npassword="file password"\n',
    );
    const loaded = loadInstanceConfig({
      overlayPath: file,
      env: {
        GLOBNOTES__ACCOUNTS_FIRST_LOGIN: " Alice ",
        GLOBNOTES__ACCOUNTS_FIRST_PASSWORD: " private password ",
      },
    });
    assertEquals(loaded.config.accounts, {
      first: { login: "alice", password: " private password " },
    });
    assertEquals([
      loaded.provenance["accounts.first.login"],
      loaded.provenance["accounts.first.password"],
    ], [{
      layer: "env",
      source: "GLOBNOTES__ACCOUNTS_FIRST_LOGIN",
      pinned: true,
    }, {
      layer: "env",
      source: "GLOBNOTES__ACCOUNTS_FIRST_PASSWORD",
      pinned: true,
    }]);
    assertEquals(
      JSON.stringify(loaded.provenance).includes("private password"),
      false,
    );
    assertEquals(
      loadInstanceConfig({ overlayPath: file, env: {} }).config.accounts,
      { first: { login: "bob", password: "file password" } },
    );
  }));

for (
  const [login, password] of [
    ["alice", ""],
    ["", "secret-value"],
    ["guest", "secret-value"],
    ["a\nb", "secret-value"],
    ["  ", "secret-value"],
  ]
) {
  Deno.test(`first account configuration: reject invalid pair without values (${JSON.stringify(login)})`, () => {
    const error = assertThrows(
      () =>
        loadInstanceConfig({
          overlayPath: null,
          env: {
            GLOBNOTES__ACCOUNTS_FIRST_LOGIN: login,
            GLOBNOTES__ACCOUNTS_FIRST_PASSWORD: password,
          },
        }),
      ConfigError,
      "config: accounts.first.login (GLOBNOTES__ACCOUNTS_FIRST_LOGIN)",
    );
    assertEquals(error.message.includes("secret-value"), false);
    assertEquals(error.message.includes("a\nb"), false);
  });
}

for (
  const content of [
    '[accounts.first]\nlogin=12\npassword="secret-value"\n',
    '[accounts.first]\nlogin="alice"\npassword="secret-value"\nhash="no"\n',
  ]
) {
  Deno.test("first account configuration: wrong types and unknown leaves are source-only failures", () =>
    identityFixture((root) => {
      const file = `${root}/instance.toml`;
      Deno.writeTextFileSync(file, content);
      const error = assertThrows(
        () => loadInstanceConfig({ overlayPath: file, env: {} }),
        ConfigError,
        `config: ${file}: accounts.first.`,
      );
      assertEquals(error.message.includes("secret-value"), false);
    }));
}

Deno.test("configured first account: ordinary sign-in, no grant or seed reapplication after password recovery", () =>
  identityFixture(async (root, scope) => {
    const f = bootstrapContext(root, scope, {
      first: { login: "alice", password: "initial" },
      target: false,
      declaredAdmin: "alice",
    });
    assertThrows(
      () => f.bootstrap.status(),
      IdentityRecoveryError,
      "public setup is unavailable.",
    );
    await assertRejects(
      () => f.bootstrap.enrolment("intruder"),
      IdentityRecoveryError,
      "public setup is unavailable.",
    );
    await f.bootstrap.provisionConfigured();
    assertEquals(f.bootstrap.status(), { setupRequired: false });
    const login = await signIn(f.sessions, {
      username: "alice",
      password: "initial",
    });
    assertEquals([
      login.principal.passwordChangeRequired,
      f.acl.declaredAdmin.accountId,
      f.acl.effectiveLevel(login.principal),
      f.acl.capture().persistence.raw,
    ], [false, login.principal.accountId, "admin", null]);
    await resetFixturePassword(
      f.accounts,
      login.principal.accountId,
      "changed",
      UPDATE,
    );
    const bytes = Deno.readTextFileSync(`${root}/accounts.json`);
    const reopened = bootstrapContext(root, scope, {
      first: { login: "bob", password: "replacement" },
      target: false,
    });
    await reopened.bootstrap.provisionConfigured();
    assertEquals([
      Deno.readTextFileSync(`${root}/accounts.json`),
      reopened.accounts.byLogin("bob"),
      reopened.acl.capture().persistence.raw,
    ], [bytes, null, null]);
    await assertRejects(
      () => reopened.sessions.login({ username: "alice", password: "initial" }),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    const next = await signIn(reopened.sessions, {
      username: "alice",
      password: "changed",
    });
    assertEquals(next.principal.accountId, login.principal.accountId);
    const noSeed = bootstrapContext(root, scope, { target: false });
    assertEquals(noSeed.bootstrap.status(), { setupRequired: false });
    Deno.removeSync(`${root}/accounts.json`);
    const lost = bootstrapContext(root, scope, {
      first: { login: "alice", password: "initial" },
      target: false,
    });
    await assertRejects(
      () => lost.bootstrap.provisionConfigured(),
      IdentityRecoveryError,
      "public setup is unavailable.",
    );
  }));
