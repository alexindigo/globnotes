// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
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
import { instanceMetadataPath } from "../server/config/paths.ts";
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
      assertEquals(await nativeFixtureInput(scenario), {
        fixtureScenario: { identity: scenario.identity },
      });
    }));
}

Deno.test("native fixture scenario: password, rejected sign-in and reopen preserve the named account", () =>
  fixtureScope(async (scope) => {
    const scenario = nativeAccountScenario({
      account: { login: "browser-user", password: "browser-password" },
    });
    const layout = await fixtureLayout(scope, {});
    const first = await fixtureScope(async (borrower) => {
      const { accounts } = await prepareIdentityBoot(
        layout,
        borrower,
        scenario.identity,
      );
      return { accounts, id: accounts.byLogin("browser-user")!.id };
    });
    await fixtureScope(async (borrower) => {
      const { accounts, signing, acl } = await prepareIdentityBoot(
        layout,
        borrower,
        scenario.identity,
      );
      assertNotStrictEquals(accounts, first.accounts);
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
    });
    assertEquals(await nativeFixtureInput(scenario), {
      fixtureScenario: { identity: scenario.identity },
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
    await fixtureScope(async (borrower) => {
      const reopened = await prepareIdentityBoot(
        layout,
        borrower,
        scenario.identity,
      );
      assertNotStrictEquals(reopened.accounts, prepared.accounts);
      const bytes = await Deno.readTextFile(prepared.filename);
      const stored = JSON.parse(bytes);
      assertEquals(bytes, prepared.before);
      assertEquals(
        stored.accounts.map((person: Record<string, unknown>) => ({
          login: person.login,
          key: person.totpKey,
          encoding: person.totpKeyEncoding ?? null,
          floor: person.lastTotpStep,
        })),
        [{ login: "browser-user", key: raw, encoding: null, floor: null }],
      );
      assertEquals(reopened.accounts.byLogin("browser-user")!.id, prepared.id);
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
    assertEquals(await nativeFixtureInput(scenario), {
      fixtureScenario: { identity: scenario.identity },
    });
  }));

Deno.test("native fixture scenario: serialization carries only the prepared account and ACL inputs", async () => {
  const scenario = nativeAccountScenario();
  assertEquals(await nativeFixtureInput(scenario), {
    fixtureScenario: { identity: scenario.identity },
  });
});

Deno.test("native fixture scenario: capture account and grants before preparation can yield", async () => {
  const account = { login: "original", password: "original-password" };
  const scenario = nativeAccountScenario({ account });
  account.login = "replacement";
  const pending = nativeFixtureInput(scenario);
  scenario.identity.people[0].login = "changed-after-call";
  const { fixtureScenario: { identity } } = await pending;
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

Deno.test("native fixture scenario: the native wrapper forwards the scenario without a legacy seed", () =>
  fixtureScope(async (scope) => {
    const scenario = nativeAccountScenario({
      everybody: "view",
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
        console.log(JSON.stringify({ identity: server.fixtureIdentity, http: [status.status, config.capabilities.canRead, config.capabilities.canEdit, config.capabilities.canManageVault] }));
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
    assertEquals(JSON.parse(result.stdout), {
      identity: scenario.identity,
      http: [200, true, false, false],
    });
    await assertRejects(
      () => Deno.readTextFile(`${layout.metadata}/config.json`),
      Deno.errors.NotFound,
    );
  }));

for (const encoding of ["base32", "historical"] as const) {
  Deno.test(`native fixture scenario: persisted ${encoding} authenticator works through account sign-in`, () =>
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
          password: "password",
          totp: code,
        }),
      });
      const issued = await reply.json();
      const instance = instanceMetadataPath(
        layout.instance,
        layout.environment.GLOBNOTES__METADATA_PATH ?? "",
      );
      const stored =
        JSON.parse(await Deno.readTextFile(`${instance}/accounts.json`))
          .accounts[0];
      assertEquals([
        reply.status,
        typeof issued.access_token,
        stored.totpKey,
        stored.totpKeyEncoding ?? null,
      ], [
        200,
        "string",
        totpKey,
        encoding === "base32" ? "base32" : null,
      ]);
    }));
}
