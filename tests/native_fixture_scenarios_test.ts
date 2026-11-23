// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertExists,
  assertNotStrictEquals,
  assertRejects,
} from "@std/assert";
import {
  nativeAccountScenario,
  nativeFixtureInput,
} from "../client/tests/e2e/config-fixture.mjs";
import { fixtureScope } from "../client/tests/e2e/fixture-ownership.mjs";
import { fixtureLayout } from "./helpers/fixture_layout.ts";
import { prepareIdentityBoot } from "./helpers/identity_fixture.ts";
import { bootServer } from "./helpers/boot.ts";
import { captureOwnedCommand } from "./helpers/owned_child.ts";
import { DENO } from "./helpers/process_values.ts";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";
import { encodeBase32 } from "@std/encoding/base32";
import { signIn } from "./helpers/session_delivery.ts";
import { GUEST, InstanceSessions } from "../server/auth/sessions.ts";
import { AuthenticationError } from "../server/auth/account_credentials.ts";

for (const everybody of ["edit", "view", "none"] as const) {
  Deno.test(`native fixture scenario: public ${everybody} and named Admin use real account stores`, () =>
    fixtureScope(async (scope) => {
      const scenario = nativeAccountScenario({ everybody });
      const layout = await fixtureLayout(scope, {});
      const prepared = await prepareIdentityBoot(
        layout,
        scope,
        scenario.identity,
      );
      const sessions = new InstanceSessions(
        prepared.accounts,
        prepared.signing,
        { expirySeconds: 1000 },
      );
      const signed = await signIn(sessions, {
        username: scenario.identity.people[0].login,
        password: scenario.identity.people[0].password,
      });
      assertEquals([
        prepared.acl.effectiveLevel(GUEST),
        prepared.acl.effectiveLevel(signed.principal),
        prepared.accounts.capture().value.accounts.map((account) =>
          account.login
        ),
      ], [everybody, "admin", ["native-admin"]]);
      const { fixtureScenario: { legacyAuth: config } } =
        await nativeFixtureInput(scenario);
      assertExists(config);
      assertEquals(
        config.auth_type,
        {
          edit: "none",
          view: "read_only",
          none: "password",
        }[everybody],
      );
      assertEquals(Object.hasOwn(config, "read_only_settings"), false);
    }));
}

Deno.test("native fixture scenario: password, rejected sign-in and reopen preserve the named account", () =>
  fixtureScope(async (scope) => {
    const scenario = nativeAccountScenario({
      account: { login: "browser-user", password: "browser-password" },
    });
    const layout = await fixtureLayout(scope, {});
    const first = await fixtureScope(async (borrower) => {
      const prepared = await prepareIdentityBoot(
        layout,
        borrower,
        scenario.identity,
      );
      return {
        accounts: prepared.accounts,
        id: prepared.accounts.byLogin("browser-user")!.id,
      };
    });
    // The original borrower has settled before opening the same layout again.
    const second = await fixtureScope(async (borrower) => {
      const reopened = await prepareIdentityBoot(
        layout,
        borrower,
        scenario.identity,
      );
      const { accounts, signing, acl } = reopened;
      const sessions = new InstanceSessions(accounts, signing, {
        expirySeconds: 1000,
      });
      await assertRejects(
        () => signIn(sessions, { username: "browser-user", password: "wrong" }),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      const signed = await signIn(sessions, {
        username: "browser-user",
        password: "browser-password",
      });
      assertEquals([
        signed.principal.accountId,
        acl.effectiveLevel(signed.principal),
        acl.effectiveLevel(GUEST),
      ], [first.id, "admin", "none"]);
      return accounts;
    });
    assertNotStrictEquals(second, first.accounts);
    const { fixtureScenario: { legacyAuth: config } } =
      await nativeFixtureInput(scenario, {}, {
        signingKey: "fixture",
      });
    assertEquals({ ...config, password_hash: "hashed" }, {
      auth_type: "password",
      username: "browser-user",
      password_hash: "hashed",
      secret_key: "fixture",
    });
  }));

Deno.test("native fixture scenario: historical authenticator input persists unchanged through account reopen", () =>
  fixtureScope(async (scope) => {
    const raw = "native-historical-authenticator";
    const scenario = nativeAccountScenario({
      account: { login: "browser-user", password: "password", totpKey: raw },
    });
    const layout = await fixtureLayout(scope, {});
    const prepared = await fixtureScope(async (borrower) => {
      const { accounts } = await prepareIdentityBoot(
        layout,
        borrower,
        scenario.identity,
      );
      const filename = `${accounts.root}/accounts.json`;
      return {
        accounts,
        id: accounts.byLogin("browser-user")!.id,
        filename,
        before: await Deno.readTextFile(filename),
      };
    });
    const { filename, before } = prepared;
    await fixtureScope(async (borrower) => {
      const reopened = await prepareIdentityBoot(
        layout,
        borrower,
        scenario.identity,
      );
      assertNotStrictEquals(reopened.accounts, prepared.accounts);
      const stored = JSON.parse(await Deno.readTextFile(filename));
      assertEquals(await Deno.readTextFile(filename), before);
      assertEquals(
        stored.accounts.map((person: Record<string, unknown>) => ({
          login: person.login,
          key: person.totpKey,
          encoding: person.totpKeyEncoding ?? null,
          floor: person.lastTotpStep,
        })),
        [{ login: "browser-user", key: raw, encoding: null, floor: null }],
      );
      assertEquals(
        reopened.accounts.byLogin("browser-user")!.id,
        prepared.id,
      );
      const sessions = new InstanceSessions(
        reopened.accounts,
        reopened.signing,
        { expirySeconds: 1000 },
      );
      await assertRejects(
        () =>
          signIn(sessions, { username: "browser-user", password: "password" }),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    });
    const { fixtureScenario: { legacyAuth: config } } =
      await nativeFixtureInput(scenario, {}, {
        signingKey: "fixture",
      });
    assertEquals({ ...config, password_hash: "hashed" }, {
      auth_type: "totp",
      username: "browser-user",
      password_hash: "hashed",
      secret_key: "fixture",
      totp_key: raw,
    });
  }));

Deno.test("native fixture scenario: active serialization retains explicit settings denial and unrelated config", async () => {
  const scenario = nativeAccountScenario({ settingsWritable: false });
  assertEquals(
    (await nativeFixtureInput(scenario, {
      brand_name: "Retained brand",
      unrelated_fixture: { kept: true },
    })).fixtureScenario.legacyAuth,
    {
      auth_type: "none",
      read_only_settings: true,
      brand_name: "Retained brand",
      unrelated_fixture: { kept: true },
    },
  );
  assertEquals(await nativeFixtureInput(scenario), {
    fixtureScenario: {
      identity: scenario.identity,
      legacyAuth: { auth_type: "none", read_only_settings: true },
    },
  });
  assertEquals(
    (await nativeFixtureInput(nativeAccountScenario({
      settingsWritable: true,
    }))).fixtureScenario.legacyAuth,
    { auth_type: "none", read_only_settings: false },
  );
});

Deno.test("native fixture scenario: compatibility metadata cannot replace owned settings or credentials", async () => {
  const publicEdit = nativeAccountScenario({ settingsWritable: false });
  const signedIn = nativeAccountScenario({ everybody: "none" });
  for (
    const [scenario, key, value] of [
      [publicEdit, "read_only_settings", false],
      [publicEdit, "auth_type", "read_only"],
      [signedIn, "username", "another-account"],
      [signedIn, "password_hash", "not-the-fixture-password"],
      [signedIn, "totp_key", "another-key"],
      [signedIn, "totp_key_encoding", "base32"],
      [signedIn, "secret_key", "not-explicit-signing-material"],
    ] as const
  ) {
    await assertRejects(
      () => nativeFixtureInput(scenario, { [key]: value }),
      TypeError,
      `Fixture metadata cannot replace ${key}.`,
    );
  }
  for (
    const [scenario, signingKey] of [[publicEdit, "public"], [
      signedIn,
      " ",
    ]] as const
  ) {
    await assertRejects(
      () => nativeFixtureInput(scenario, {}, { signingKey }),
      TypeError,
      "A legacy signing key override requires a signed-in scenario and a nonempty key.",
    );
  }
});

Deno.test("native fixture scenario: capture account, grants and extras before asynchronous hashing", async () => {
  const account = { login: "original", password: "original-password" };
  const scenario = nativeAccountScenario({ account });
  account.login = "replacement";
  const extra = { unrelated: { kept: true } };
  const signing = { signingKey: "original-secret" };
  const pending = nativeFixtureInput(scenario, extra, signing);
  scenario.identity.people[0].login = "changed-after-call";
  extra.unrelated.kept = false;
  signing.signingKey = "new-secret";
  const { fixtureScenario: { identity, legacyAuth: config } } = await pending;
  assertEquals({ ...config, password_hash: "hashed" }, {
    auth_type: "password",
    username: "original",
    password_hash: "hashed",
    secret_key: "original-secret",
    unrelated: { kept: true },
  });
  assertEquals(scenario.identity.grants, { original: "admin" });
  assertEquals(identity, {
    vaultId: scenario.identity.vaultId,
    people: [{ login: "original", password: "original-password" }],
    everybody: "none",
    grants: { original: "admin" },
  });
});

Deno.test("native fixture scenario: read each supplied account field once and grant Admin to that same login", () => {
  const reads: string[] = [];
  const scenario = nativeAccountScenario({
    account: {
      get login() {
        reads.push("login");
        return reads.length === 1 ? "captured-account" : "read-again";
      },
      get password() {
        reads.push("password");
        return "captured-password";
      },
      get totpKey() {
        reads.push("totpKey");
        return "captured-key";
      },
      get totpKeyEncoding() {
        reads.push("totpKeyEncoding");
        return "base32" as const;
      },
      get temporary() {
        reads.push("temporary");
        return true;
      },
    },
  });
  assertEquals({ reads, scenario }, {
    reads: ["login", "password", "totpKey", "totpKeyEncoding", "temporary"],
    scenario: {
      identity: {
        vaultId: "00000000-0000-4000-8000-000000000003",
        people: [{
          login: "captured-account",
          password: "captured-password",
          totpKey: "captured-key",
          totpKeyEncoding: "base32",
          temporary: true,
        }],
        everybody: "none",
        grants: { "captured-account": "admin" },
      },
      signIn: true,
    },
  });
});

Deno.test("native fixture scenario: the native wrapper forwards and returns the scenario", () =>
  fixtureScope(async (scope) => {
    const scenario = nativeAccountScenario({
      everybody: "view",
      settingsWritable: false,
    });
    const { fixtureScenario } = await nativeFixtureInput(scenario);
    const layout = await fixtureLayout(scope, {});
    // Native origin discovery needs networkInterfaces. As in the relative-path
    // native fixture test, grant it only to the child running the wrapper.
    const probe = `${layout.artifacts}/native-scenario.mjs`;
    await Deno.writeTextFile(
      probe,
      `
      import { bootServer } from ${
        JSON.stringify(
          new URL("../client/tests/e2e/harness-helpers.mjs", import.meta.url)
            .href,
        )
      };
      import { assertHttpTestUrl } from ${
        JSON.stringify(
          new URL("../client/tests/e2e/http-origin.mjs", import.meta.url).href,
        )
      };
      import { fixtureScope } from ${
        JSON.stringify(
          new URL("./helpers/fixture_scope.ts", import.meta.url).href,
        )
      };
      await fixtureScope(async scope => {
        const server = (await scope.acquire(() => bootServer(${
        JSON.stringify(layout.vault)
      }, ${JSON.stringify(layout.metadata)}, { fixtureScenario: ${
        JSON.stringify(fixtureScenario)
      } }), value => value.close())).value;
        const status = await fetch(new URL("/_/api/config", assertHttpTestUrl(server.baseUrl)));
        const config = await status.json();
        console.log(JSON.stringify({ identity: server.fixtureIdentity, http: [status.status, config.authType, config.settingsWritable] }));
      });
    `,
    );
    const result = await captureOwnedCommand(scope, DENO, {
      cwd: Deno.cwd(),
      env: { GLOBNOTES_TEST_HOST: Deno.env.get("GLOBNOTES_TEST_HOST") ?? "" },
      args: [
        "run",
        "--cached-only",
        "--frozen",
        "--config=deno.json",
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        "--allow-run",
        "--allow-sys=networkInterfaces",
        probe,
      ],
    });
    assertEquals(result.status.success, true, result.stderr);
    assertEquals({
      ...JSON.parse(result.stdout),
      config: JSON.parse(
        await Deno.readTextFile(`${layout.metadata}/config.json`),
      ),
    }, {
      identity: scenario.identity,
      http: [200, "read_only", false],
      config: { auth_type: "read_only", read_only_settings: true },
    });
  }));

for (const encoding of ["base32", "historical"] as const) {
  Deno.test(`native fixture scenario: serialized ${encoding} authenticator works through legacy sign-in`, () =>
    fixtureScope(async (scope) => {
      const layout = await fixtureLayout(scope, {});
      const totpKey = encoding === "base32"
        ? "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
        : "historical raw key";
      const scenario = nativeAccountScenario({
        account: {
          login: "alice",
          password: "password",
          totpKey,
          ...(encoding === "base32"
            ? { totpKeyEncoding: "base32" as const }
            : {}),
        },
      });
      const input = await nativeFixtureInput(scenario);
      const clock = (await scope.acquire(() =>
        createNativeTotpClock(layout.artifacts), (value) =>
        value.close())).value;
      const server = (await scope.acquire(() =>
        bootServer(input, { layout, denoArgs: clock.denoArgs }), (value) =>
        value.close())).value;
      const secret = encoding === "base32"
        ? totpKey
        : encodeBase32(new TextEncoder().encode(totpKey)).replace(/=+$/, "");
      const code = await clock.code(secret);
      const reply = await fetch(`${server.baseUrl}/_/api/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "alice",
          password: "password" + code,
        }),
      });
      const issued = await reply.json();
      const stored = JSON.parse(
        await Deno.readTextFile(`${layout.metadata}/config.json`),
      );
      assertEquals([
        reply.status,
        typeof issued.access_token,
        stored.totp_key,
        stored.totp_key_encoding,
      ], [
        200,
        "string",
        totpKey,
        encoding === "base32" ? "base32" : undefined,
      ]);
    }));
}
