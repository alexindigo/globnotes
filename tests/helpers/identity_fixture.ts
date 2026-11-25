// SPDX-License-Identifier: LGPL-3.0-only
import { AccountRepository } from "../../server/auth/accounts.ts";
import {
  type AccessLevel,
  AclRepository,
  type EverybodyLevel,
} from "../../server/auth/acl.ts";
import {
  InstanceSessions,
  SessionRepository,
} from "../../server/auth/sessions.ts";
import { createInstanceAuth } from "../../server/auth/middleware.ts";
import { singleIdentityVault } from "../../server/auth/http_policy.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import { createUuid } from "../../shared/uuid.ts";
import { identityFixture, prepareFixtureAccount, VAULT_A } from "./identity.ts";
import { importFixtureAccount } from "./account_preparation.ts";
import { fixturePasswordHash } from "./config.ts";
import type { FixtureScope } from "./fixture_scope.ts";
import { signIn } from "./session_delivery.ts";

/** Explicit v3 inputs, alongside the still-active legacy fixtures. */
export async function seedIdentityRecords(input: {
  scope: FixtureScope;
  instancePath: string;
  vaultPath: string;
  vaultId: string;
  people: readonly {
    login: string;
    password: string;
    totpKey?: string;
    temporary?: boolean;
  }[];
  everybody: EverybodyLevel;
  grants: Readonly<Record<string, AccessLevel>>;
  declaredAdmin?: string;
}) {
  const accounts = new AccountRepository(input.instancePath);
  input.scope.onCancel(() => accounts.retireCredentials());
  if (
    accounts.initialized || accounts.capture().value.revision !== 0 ||
    input.people.length === 0
  ) {
    throw new Error(
      "Identity fixture requires fresh stores and explicit people.",
    );
  }
  const openAcl = () =>
    new AclRepository(input.vaultPath, input.vaultId, {
      accounts,
      declaredAdmin: input.declaredAdmin,
    });
  const assertFreshAcl = (snapshot: ReturnType<AclRepository["capture"]>) => {
    if (snapshot.persistence.raw !== null) {
      throw new Error("Identity fixture requires a fresh ACL.");
    }
  };
  assertFreshAcl(openAcl().capture());
  accounts.prepareParents();
  // Preparation can establish the account-root binding used by the ACL.
  const acl = openAcl();
  const initialAcl = acl.capture();
  assertFreshAcl(initialAcl);
  const signing = new SessionRepository(input.instancePath);
  if (signing.capture().persistence.raw !== null) {
    throw new Error("Identity fixture requires fresh signing state.");
  }
  signing.initialize();
  for (const person of input.people) {
    const account = await prepareFixtureAccount(person.login, person.password, {
      temporary: person.temporary,
      hash: (password) => Promise.resolve(fixturePasswordHash(password)),
    });
    importFixtureAccount(accounts, {
      ...account,
      totpKey: person.totpKey ?? null,
    });
  }
  const grants = Object.fromEntries(
    Object.entries(input.grants).map(([login, level]) => {
      const account = accounts.byLogin(login);
      if (!account) {
        throw new Error("Fixture grant requires an explicit person.");
      }
      return [account.id, level];
    }),
  );
  acl.save({ everybody: input.everybody, grants }, initialAcl, {
    updateId: createUuid(),
    actorId: null,
  });
  return { accounts, signing, acl };
}

export async function identityHttpFixture(
  run: (f: Awaited<ReturnType<typeof httpContext>>) => Promise<void>,
) {
  await identityFixture(async (root, scope) =>
    await run(await httpContext(root, scope))
  );
}
async function httpContext(root: string, scope: FixtureScope) {
  const records = await seedIdentityRecords({
    scope,
    instancePath: `${root}/identity`,
    vaultPath: `${root}/metadata`,
    vaultId: VAULT_A,
    people: [{ login: "alice", password: "password" }, {
      login: "bob",
      password: "password",
    }],
    everybody: "none",
    grants: { alice: "admin", bob: "view" },
  });
  const lifetime = createOperationLease("live", [() => {}]);
  scope.onCancel(() => lifetime.retire());
  const sessions = new InstanceSessions(records.accounts, records.signing, {
    expirySeconds: 1000,
  });
  const vault = {
    identity: {},
    id: VAULT_A,
    acl: records.acl,
    lifecycle: { epoch: 0, operational: () => true },
  };
  const auth = createInstanceAuth({
    sessions,
    vault: singleIdentityVault(vault),
    cookieName: "instance-token",
    lifetime: () => lifetime.lease,
  });
  const signed = await signIn(sessions, {
    username: "bob",
    password: "password",
  });
  const alice = records.accounts.byLogin("alice")!,
    bob = records.accounts.byLogin("bob")!;
  const policy = (level: AccessLevel) =>
    records.acl.save(
      { everybody: "none", grants: { [alice.id]: "admin", [bob.id]: level } },
      records.acl.capture(),
      { updateId: createUuid(), actorId: alice.id },
    );
  const request = (
    method = "GET",
    headers: Record<string, string> = {
      cookie: `instance-token=${signed.access_token}`,
    },
  ) =>
    new Request(
      "http://globnotes.test/instance/attachment.txt?vault=globnotes",
      { method, headers },
    );
  return {
    ...records,
    root,
    scope,
    sessions,
    vault,
    auth,
    signed,
    alice,
    bob,
    policy,
    request,
    lifetime,
  };
}
