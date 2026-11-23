// SPDX-License-Identifier: LGPL-3.0-only
import {
  AccountRepository,
  normalizeLogin,
} from "../../server/auth/accounts.ts";
import {
  type AccessLevel,
  AclRepository,
  type EverybodyLevel,
  validateAcl,
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
import { loadInstanceConfig } from "../../server/config/loader.ts";
import {
  singleVaultBindings,
  singleVaultSettings,
} from "../../server/config/single_vault.ts";
import {
  admitLayout,
  bindLayout,
  type FixtureLayout,
  layoutEnvironment,
} from "./fixture_layout.ts";

/** Serializable account inputs, independent of the active legacy boot adapter. */
export interface IdentityFixturePayload {
  vaultId: string;
  people: readonly (
    & {
      login: string;
      password: string;
      temporary?: boolean;
    }
    & (
      | { totpKey?: string; totpKeyEncoding?: undefined }
      | { totpKey: string; totpKeyEncoding: "base32" }
    )
  )[];
  everybody: EverybodyLevel;
  grants: Readonly<Record<string, AccessLevel>>;
  declaredAdmin?: string;
}
type IdentityFixtureInput = IdentityFixturePayload & {
  scope: FixtureScope;
  instancePath: string;
  vaultPath: string;
};
export function identityFixturePayload(
  input: IdentityFixturePayload,
): IdentityFixturePayload {
  return structuredClone(input);
}

/** No roots or children are allocated here: P03/P15 retain that custody. This
 * prepares data beside the old boot adapter; I14c alone switches its callers. */
const preparedLayouts = new WeakMap<FixtureLayout, {
  scope: FixtureScope;
  pending: ReturnType<typeof prepareLayoutRecords>;
}>();
export async function prepareIdentityBoot(
  layout: FixtureLayout,
  scope: FixtureScope,
  payload: IdentityFixturePayload,
) {
  const captured = identityFixturePayload(payload);
  bindLayout(layout, scope);
  scope.assertCurrent();
  const existing = preparedLayouts.get(layout);
  if (existing) {
    if (existing.scope === scope) return await existing.pending;
    throw new Error("Identity fixture layout is already borrowed.");
  }
  const pending = prepareLayoutRecords(layout, scope, captured);
  const slot = { scope, pending };
  const release = () => {
    if (preparedLayouts.get(layout) === slot) preparedLayouts.delete(layout);
  };
  scope.defer(release);
  preparedLayouts.set(layout, slot);
  try {
    return await pending;
  } catch (error) {
    release();
    throw error;
  }
}

async function prepareLayoutRecords(
  layout: FixtureLayout,
  scope: FixtureScope,
  captured: IdentityFixturePayload,
) {
  return (await admitLayout(layout, scope, async () => {
    const env = { ...layoutEnvironment(layout) };
    const loaded = loadInstanceConfig({
      env,
      overlayPath: null,
      vaults: singleVaultBindings,
    });
    const paths = singleVaultSettings(loaded, env);
    if (
      paths.notesPath !== layout.vault || paths.statePath !== layout.metadata
    ) {
      throw new Error("Identity preparation cannot replace its owned layout.");
    }
    const records = await openIdentityFixture({
      ...captured,
      scope,
      instancePath: paths.instancePath,
      vaultPath: paths.statePath,
    });
    return { env, paths, ...records };
  })).value;
}

export function seedIdentityRecords(input: IdentityFixtureInput) {
  return identityRecords(input, false);
}
/** Reopening validates all stores without resetting passwords, codes or grants. */
export function openIdentityFixture(input: IdentityFixtureInput) {
  return identityRecords(input, true);
}
async function identityRecords(source: IdentityFixtureInput, reopen: boolean) {
  const { scope, ...values } = source;
  const input = structuredClone(values);
  return (await scope.admit(async () => {
    const accounts = new AccountRepository(input.instancePath);
    scope.onCancel(() => accounts.retireCredentials());
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
    if (!reopen) assertFreshAcl(openAcl().capture());
    // Prepare the shared instance parent before sibling owners capture it.
    // Otherwise its legitimate creation invalidates their absent-path CAS.
    accounts.prepareParents();
    const signing = new SessionRepository(input.instancePath);
    const acl = openAcl();
    const initialAcl = acl.capture();
    if (!reopen) assertFreshAcl(initialAcl);
    // The account directory intentionally contains no raw persistence record.
    // Check presence only; all contents are validated by the real repository.
    let accountFile = false;
    try {
      Deno.lstatSync(`${accounts.root}/accounts.json`);
      accountFile = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const present = [
      accountFile,
      signing.capture().persistence.raw !== null,
      initialAcl.persistence.raw !== null,
    ];
    if (reopen && present.every(Boolean)) {
      if (!accounts.initialized) {
        throw new Error("Incomplete identity fixture.");
      }
      signing.current();
      return { accounts, signing, acl };
    }
    if (present.some(Boolean) || input.people.length === 0) {
      throw new Error(
        reopen
          ? "Incomplete identity fixture."
          : "Identity fixture requires fresh stores and explicit people.",
      );
    }
    const logins = input.people.map((person) => normalizeLogin(person.login));
    if (new Set(logins).size !== logins.length) {
      throw new Error("Identity fixture requires distinct people.");
    }
    for (const login of Object.keys(input.grants)) {
      if (!logins.includes(normalizeLogin(login))) {
        throw new Error("Fixture grant requires an explicit person.");
      }
    }
    // Hash before publishing any record; cancellation retains the original work
    // and retires aggregate credentials before the scope releases its roots.
    const prepared = [];
    for (const person of input.people) {
      const account = await prepareFixtureAccount(
        person.login,
        person.password,
        {
          temporary: person.temporary,
          hash: (password) => Promise.resolve(fixturePasswordHash(password)),
          authenticator: {
            totpKey: person.totpKey ?? null,
            ...(person.totpKeyEncoding === undefined
              ? {}
              : { totpKeyEncoding: person.totpKeyEncoding }),
          },
        },
      );
      scope.assertCurrent();
      prepared.push(account);
    }
    const ids = new Map(prepared.map((account) => [account.login, account.id]));
    const grants = Object.fromEntries(
      Object.entries(input.grants).map(
        ([login, level]) => [ids.get(normalizeLogin(login))!, level],
      ),
    );
    const next = validateAcl({
      version: 1,
      vaultId: input.vaultId,
      revision: 1,
      updateId: createUuid(),
      updateActorId: null,
      everybody: input.everybody,
      grants,
    }, input.vaultId);
    signing.initialize();
    for (const account of prepared) importFixtureAccount(accounts, account);
    acl.save({ everybody: next.everybody, grants: next.grants }, initialAcl, {
      updateId: next.updateId!,
      actorId: null,
    });
    return { accounts, signing, acl };
  })).value;
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
