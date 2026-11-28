// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { AccountRepository } from "../../server/auth/accounts.ts";
import { type AccessLevel, AclRepository } from "../../server/auth/acl.ts";
import {
  InstanceSessions,
  SessionRepository,
} from "../../server/auth/sessions.ts";
import {
  createIdentityComposition,
  identityServiceEligibility,
  type IdentityStreamAccess,
} from "../../server/auth/composition.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import { fixturePage, withPluginFixture } from "./plugin_fixture.ts";
import { withPluginOperationsFixture } from "./plugin_operations_fixture.ts";
import { importFixtureAccount } from "./account_preparation.ts";
import { prepareFixtureAccount, UPDATE, VAULT_A } from "./identity.ts";
import { signIn } from "./session_delivery.ts";
import { fixtureGate } from "./fixture_coordination.ts";
import type { FixtureScope } from "./fixture_scope.ts";

const SERVICE = [
  "export function activate(ctx){",
  "ctx.commands.register({id:'write',label:'Background write',target:'server'},",
  "path=>ctx.actions.request('create',{path,content:'service-owned',base:{kind:'absent'}}));",
  "ctx.commands.register({id:'settle-action',label:'Settle action',target:'server'},",
  "async id=>{for(;;){const receipt=await ctx.actions.result(id);",
  "if(!['accepted','running'].includes(receipt.status))return receipt;",
  "await new Promise(resolve=>ctx.timers.setTimeout(resolve,0));}});}",
].join("");

/** Prepared composition consumer fixture. P03 owns the plugin root, runtime and
 * every repository from construction; the test supplies and retires the
 * explicit composition lifetime. No server boot or layout is constructed. */
export function withIdentityScope<T>(
  body: (f: Awaited<ReturnType<typeof prepare>>) => T | PromiseLike<T>,
  options: { expirySeconds?: number } = {},
): Promise<T> {
  return withPluginFixture((fixture, scope) =>
    prepare(fixture, scope, options).then(body)
  );
}

async function prepare(
  fixture: Parameters<Parameters<typeof withPluginFixture>[0]>[0],
  scope: Parameters<Parameters<typeof withPluginFixture>[0]>[1],
  options: { expirySeconds?: number },
) {
  const accounts = new AccountRepository(`${fixture.root}/identity`);
  scope.defer(() => accounts.retireCredentials());
  const alice = importFixtureAccount(
    accounts,
    await prepareFixtureAccount("alice", "password"),
  );
  const bob = importFixtureAccount(
    accounts,
    await prepareFixtureAccount("bob", "password"),
  );
  const signing = new SessionRepository(accounts.root);
  signing.initialize();
  const sessions = new InstanceSessions(accounts, signing, {
    expirySeconds: options.expirySeconds ?? 1000,
  });
  const token = await signIn(sessions, {
    username: "alice",
    password: "password",
  });
  const other = await signIn(sessions, {
    username: "bob",
    password: "password",
  });
  const acl = new AclRepository(fixture.statePath, VAULT_A, { accounts });
  acl.prepareParents();
  acl.initializeForCreator(alice, "view");
  const lifetime = createOperationLease("live", [() => undefined]);
  scope.defer(() => lifetime.retire());
  return {
    fixture,
    scope,
    accounts,
    alice,
    bob,
    signing,
    sessions,
    token,
    other,
    acl,
    lifetime,
  };
}

/** Runs the scenario inside the real plugin operations fixture, borrowed by the
 * enclosing scope, with instance service eligibility from the same sessions. */
export function withIdentityComposition<T>(
  body: (f: Awaited<ReturnType<typeof compose>>) => T | PromiseLike<T>,
  options: { expirySeconds?: number; changeLimit?: number; browser?: boolean } =
    {},
): Promise<T> {
  return withIdentityScope(
    (identity) =>
      withPluginOperationsFixture({
        fixture: identity.fixture,
        id: "projection",
        serviceEligibility: identityServiceEligibility(identity.sessions),
        changeLimit: options.changeLimit,
        manifest: {
          runtime: {
            server: "service.js",
            ...(options.browser ? { client: "browser.js" } : {}),
          },
          capabilities: { read: ["vault"], write: ["vault"] },
          settings: [fixturePage],
        },
        files: {
          "service.js": SERVICE,
          ...(options.browser
            ? { "browser.js": "export function activate() {}" }
            : {}),
        },
      }, (operations) => body(compose(identity, operations))),
    options,
  );
}

function compose(
  identity: Awaited<ReturnType<typeof prepare>>,
  operations: Parameters<
    Parameters<typeof withPluginOperationsFixture>[1]
  >[0],
) {
  const composition = createIdentityComposition({
    sessions: identity.sessions,
    acl: identity.acl,
    vaultId: VAULT_A,
    config: operations.config,
    lifecycle: operations.lifecycle,
    cookieName: "identity",
    lifetime: identity.lifetime.lease,
    plugins: () => operations.manager,
    setupStatus: () => ({ setupRequired: false }),
    release: { version: "fixture", revision: "fixture-revision" },
  });
  const request = (
    query = "",
    bearer = identity.token.access_token,
    signal?: AbortSignal,
  ) =>
    new Request(`http://globnotes.test/_/api/changes${query}`, {
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "text/event-stream",
      },
      signal,
    });
  return {
    ...identity,
    operations,
    composition,
    request,
    services: {
      vaultId: VAULT_A,
      hub: operations.hub,
      root: identity.fixture.vault,
      stateRoot: identity.fixture.statePath,
    },
    policy(level: AccessLevel, everybody: "view" | "none" = "view") {
      return identity.acl.save(
        { everybody, grants: { [identity.alice.id]: level } },
        identity.acl.capture(),
        { updateId: UPDATE, actorId: identity.alice.id },
      );
    },
  };
}

/** Pathfinder's request projection for direct handler consumers. */
export function pathfinderRequest(raw: Request): PathfinderRequest {
  return {
    _raw: raw,
    query: new URL(raw.url).searchParams,
  } as PathfinderRequest;
}

/** Counts each admitted subscription; idle() joins the scope-owned release gate. */
export function streamProbe(
  scope: FixtureScope,
  admit: (request: Request) => Promise<IdentityStreamAccess>,
  afterAdmission: () => void = () => {},
) {
  let active = 0, subscriptions = 0;
  let released: ReturnType<typeof fixtureGate> | undefined;
  return {
    get active() {
      return active;
    },
    get subscriptions() {
      return subscriptions;
    },
    /** Resolves when no admitted subscription remains registered. */
    idle: () => released ? released.promise : Promise.resolve(),
    async admit(request: Request): Promise<IdentityStreamAccess> {
      const access = await admit(request);
      afterAdmission();
      return {
        ...access,
        subscribe(listener: () => void) {
          if (active++ === 0) released = fixtureGate(scope);
          subscriptions++;
          const release = access.subscribe(listener);
          let done = false;
          return () => {
            if (done) return;
            done = true;
            release();
            if (--active === 0) released!.resolve();
          };
        },
      };
    },
  };
}
