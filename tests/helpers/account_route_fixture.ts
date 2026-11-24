// SPDX-License-Identifier: LGPL-3.0-only
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { state } from "../../server/state.ts";
import { type FixtureScope, fixtureScope } from "./fixture_scope.ts";
import { GlobalConfig } from "./config.ts";
import { openFixtureIdentity } from "./identity_fixture.ts";
import { type FixtureScenario, publicScenario } from "./fixture_scenarios.ts";
import { testEnvironment, testServices } from "./environment.ts";
import { installFixtureState } from "./state.ts";
import { signIn } from "./session_delivery.ts";
import { createUuid } from "../../shared/uuid.ts";

export function accountRouteFixture<T>(
  run: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<T>,
  options: { scenario?: FixtureScenario; brand?: string } = {},
) {
  return fixtureScope(async (scope) =>
    await run(await prepare(scope, options))
  );
}

async function prepare(
  scope: FixtureScope,
  { scenario = publicScenario(), brand }: {
    scenario?: FixtureScenario;
    brand?: string;
  },
) {
  const root = (await scope.acquire(
    () => Deno.makeTempDir({ prefix: "account-route-" }),
    (root) => Deno.remove(root, { recursive: true }),
  )).value;
  const vault = `${root}/vault`, storage = `${root}/state`;
  Deno.mkdirSync(vault);
  Deno.mkdirSync(storage);
  if (brand) Deno.writeTextFileSync(`${storage}/config.toml`, brand);
  const env = testEnvironment({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    GLOBNOTES__METADATA_PATH: `${root}/metadata`,
    fixtureStatePath: storage,
    fixtureScenario: scenario,
  });
  const config = new GlobalConfig(env);
  const identity = await openFixtureIdentity(
    scope,
    config,
    scenario.identity,
    () => state.plugins!,
  );
  const notes = new FileSystemNotes(vault, {}, testServices(env).notes);
  installFixtureState(
    scope.defer,
    config,
    identity,
    notes,
    null,
    new FileServing(vault),
  );
  const alice = () =>
    signIn(identity.sessions, { username: "alice", password: "password" });
  const demoteAdmin = () => {
    const before = identity.acl.capture(),
      id = identity.accounts.byLogin("alice")!.id;
    identity.acl.save(
      {
        everybody: before.value.everybody,
        grants: { ...before.value.grants, [id]: "edit" },
      },
      before,
      { actorId: id, updateId: createUuid() },
    );
    return identity.acl.capture().persistence.raw;
  };
  return {
    root,
    vault,
    config,
    identity,
    scope,
    lifecycle: identity.composition.lifecycle,
    alice,
    demoteAdmin,
  };
}
