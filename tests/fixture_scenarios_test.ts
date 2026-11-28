// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  accountScenario,
  publicScenario,
  setupScenario,
  signedInScenario,
  storedScenario,
} from "./helpers/fixture_scenarios.ts";
import { GlobalConfig } from "./helpers/config.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { fixtureLayout } from "./helpers/fixture_layout.ts";
import { prepareIdentityBoot } from "./helpers/identity_fixture.ts";
import { GUEST, InstanceSessions } from "../server/auth/sessions.ts";
import { AuthenticationError } from "../server/auth/account_credentials.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { bootServer } from "./helpers/boot.ts";
import { instanceMetadataPath } from "../server/config/paths.ts";

for (const everybody of ["edit", "view"] as const) {
  Deno.test(`fixture scenarios: public ${everybody} input reaches prepared accounts without public Admin`, () =>
    fixtureScope(async (scope) => {
      const scenario = publicScenario(everybody);
      const env = testEnvironment({ fixtureScenario: scenario });
      assertEquals(env.values, {});
      assertEquals(env.fixtureIdentity?.everybody, everybody);
      const layout = await fixtureLayout(scope, {});
      const records = await prepareIdentityBoot(
        layout,
        scope,
        env.fixtureIdentity!,
      );
      const sessions = new InstanceSessions(records.accounts, records.signing, {
        expirySeconds: 1000,
      });
      const alice = await signIn(sessions, {
        username: "alice",
        password: "password",
      });
      assertEquals([
        records.acl.effectiveLevel(GUEST),
        records.acl.effectiveLevel(alice.principal),
      ], [everybody, "admin"]);
    }));
}

Deno.test("fixture scenarios: named password and explicit None preserve actual sign-in and denied public access", () =>
  fixtureScope(async (scope) => {
    const scenario = signedInScenario(
      { login: "agent", password: "correct horse" },
      { level: "edit" },
    );
    const env = testEnvironment({ fixtureScenario: scenario });
    assertEquals(env.values, {});
    assertEquals(env.fixtureIdentity?.people, [{
      login: "agent",
      password: "correct horse",
    }]);
    const layout = await fixtureLayout(scope, {});
    const records = await prepareIdentityBoot(
      layout,
      scope,
      env.fixtureIdentity!,
    );
    const sessions = new InstanceSessions(records.accounts, records.signing, {
      expirySeconds: 1000,
    });
    await assertRejects(
      () => signIn(sessions, { username: "agent", password: "wrong" }),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    const signed = await signIn(sessions, {
      username: "agent",
      password: "correct horse",
    });
    assertEquals([
      records.acl.effectiveLevel(signed.principal),
      records.acl.effectiveLevel(GUEST),
    ], ["edit", "none"]);
  }));

Deno.test("fixture scenarios: named identity and grant derive from the same person snapshot", () => {
  let loginReads = 0;
  const scenario = signedInScenario(
    {
      get login() {
        return ++loginReads === 1 ? "alice" : "bob";
      },
      password: "password",
      totpKey: "historical-raw-key",
    },
    { level: "edit" },
  );
  assertEquals([loginReads, scenario.identity], [
    1,
    {
      vaultId: publicScenario().identity!.vaultId,
      everybody: "none",
      people: [{
        login: "alice",
        password: "password",
        totpKey: "historical-raw-key",
      }],
      grants: { alice: "edit" },
    },
  ]);
});

Deno.test("fixture scenarios: default named credentials issue a usable token on a fresh account boot", () =>
  fixtureScope(async (scope) => {
    const layout = await fixtureLayout(scope, {});
    const scenario = signedInScenario({ login: "alice", password: "password" });
    const server = (await scope.acquire(
      () => bootServer({ fixtureScenario: scenario }, { layout }),
      (server) => server.close(),
    )).value;
    const reply = await fetch(`${server.baseUrl}/_/api/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password" }),
    });
    assertEquals(reply.status, 200);
    const { access_token, token_type } = await reply.json();
    assert(typeof access_token === "string" && access_token.length > 0);
    assertEquals(token_type, "bearer");
    const check = await fetch(`${server.baseUrl}/_/api/auth-check`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    const status = await check.json();
    assertEquals([check.status, status.principal?.login], [200, "alice"]);
  }));

Deno.test("fixture scenarios: authenticator representation, temporary password and distinct named grants survive capture", () => {
  const people = [
    { login: "old-key", password: "password", totpKey: "historical-raw-key" },
    {
      login: "new-key",
      password: "password",
      totpKey: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      totpKeyEncoding: "base32" as const,
      temporary: true,
    },
  ];
  const source = accountScenario({
    vaultId: publicScenario().identity!.vaultId,
    people,
    everybody: "edit",
    grants: { "old-key": "none", "new-key": "view" },
  });
  const env = testEnvironment({ fixtureScenario: source });
  people[0].totpKey = "replacement";
  source.identity!.grants = {};
  assertEquals(env.fixtureIdentity, {
    vaultId: publicScenario().identity!.vaultId,
    people: [
      { login: "old-key", password: "password", totpKey: "historical-raw-key" },
      {
        login: "new-key",
        password: "password",
        totpKey: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        totpKeyEncoding: "base32",
        temporary: true,
      },
    ],
    everybody: "edit",
    grants: { "old-key": "none", "new-key": "view" },
  });
  assertEquals(
    signedInScenario({
      login: "old-key",
      password: "password",
      totpKey: "historical-raw-key",
    }).identity?.people[0].totpKey,
    "historical-raw-key",
  );
});

Deno.test("fixture scenarios: setup has neither a fabricated account nor a serialized auth record", () => {
  const env = testEnvironment({ fixtureScenario: setupScenario() });
  assertEquals([env.fixtureIdentity, env.values], [
    null,
    {},
  ]);
  assertThrows(
    () =>
      testEnvironment({
        fixtureScenario: publicScenario(),
        fixtureAuth: { auth_type: "password" },
      }),
    Error,
    "Fixture env fixtureAuth must be text",
  );
});

Deno.test("fixture scenarios: environment captures scenario getters once and config retains only the captured account input", () =>
  fixtureScope(async (scope) => {
    const reads: string[] = [];
    const source = publicScenario("view");
    const env = testEnvironment(
      Object.defineProperty({}, "fixtureScenario", {
        enumerable: true,
        get() {
          reads.push("scenario");
          return source;
        },
      }),
    );
    source.identity!.everybody = "edit";
    const layout = await fixtureLayout(scope, {});
    const config = new GlobalConfig(
      testEnvironment({
        ...layout.environment,
        fixtureScenario: env.fixtureScenario,
      }),
    );
    assertEquals(reads, ["scenario"]);
    assertThrows(() => {
      env.fixtureScenario!.identity!.everybody = "edit";
    }, TypeError);
    assertThrows(() => {
      env.fixtureIdentity!.people[0].login = "other";
    }, TypeError);
    assertThrows(() => {
      config.fixtureIdentity!.grants = {};
    }, TypeError);
    assertEquals([
      env.fixtureIdentity!.everybody,
      env.fixtureIdentity!.people[0].login,
    ], [
      "view",
      "alice",
    ]);
    assertEquals(config.fixtureIdentity!.everybody, "view");
  }));

Deno.test("fixture scenarios: boot captures account input and preserves public writes and exact persisted identity on reopen", () =>
  fixtureScope(async (scope) => {
    const layout = await fixtureLayout(scope, {}), scenario = publicScenario();
    const starting = bootServer({ fixtureScenario: scenario }, { layout });
    scenario.identity!.everybody = "view";
    const server = (await scope.acquire(() =>
      starting, (server) => server.close())).value;
    assertEquals(server.fixtureIdentity!.everybody, "edit");
    const saved = await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "Scenario",
        content: "retained original note",
      }),
    });
    assertEquals(saved.status, 200);
    await saved.body?.cancel();
    assertEquals(
      await Deno.readTextFile(`${server.vault}/Scenario.md`),
      "retained original note",
    );
    const instance = instanceMetadataPath(
      layout.instance,
      layout.environment.GLOBNOTES__METADATA_PATH ?? "",
    );
    const acl = `${layout.metadata}/access.json`;
    const accounts = `${instance}/accounts.json`;
    const signing = `${instance}/sessions.json`;
    const bytes = await Deno.readTextFile(acl);
    const accountBytes = await Deno.readTextFile(accounts);
    const signingBytes = await Deno.readTextFile(signing);
    assertEquals(JSON.parse(bytes).everybody, "edit");
    assertThrows(
      () => Deno.statSync(`${layout.metadata}/config.json`),
      Deno.errors.NotFound,
      "No such file",
    );
    await server.close();
    const replacement =
      JSON.stringify({ ...JSON.parse(bytes), everybody: "view" }) + "\n";
    await Deno.writeTextFile(acl, replacement);
    const reopened = (await scope.acquire(() =>
      bootServer({ fixtureScenario: storedScenario(publicScenario()) }, {
        layout,
      }), (server) =>
      server.close())).value;
    assertEquals(reopened.fixtureIdentity, publicScenario().identity);
    assertEquals(
      await Deno.readTextFile(acl),
      replacement,
    );
    const current = await fetch(`${reopened.baseUrl}/_/api/config`);
    const { capabilities } = await current.json();
    assertEquals([current.status, capabilities.canRead, capabilities.canEdit], [
      200,
      true,
      false,
    ]);
    assertEquals(await Deno.readTextFile(accounts), accountBytes);
    assertEquals(await Deno.readTextFile(signing), signingBytes);
    const note = await fetch(`${reopened.baseUrl}/_/api/notes/Scenario`);
    assertEquals(note.status, 200);
    assertEquals((await note.json()).content, "retained original note");
  }));
