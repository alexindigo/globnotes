// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { fixtureGate, fixtureTest } from "./helpers/fixture_coordination.ts";
import type { FixtureScope } from "./helpers/fixture_scope.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { AccountRepository } from "../server/auth/accounts.ts";
import { prepareFixtureAccount } from "./helpers/identity.ts";
import {
  disableFixtureAuthenticator,
  importFixtureAccount,
} from "./helpers/account_preparation.ts";
import { AclRepository, type AclValues } from "../server/auth/acl.ts";
import {
  type AuthorityVault,
  InstanceAuthority,
  type PreparedAuthorityRead,
  type VaultAuthorityLease,
} from "../server/auth/authority.ts";

async function delivered<T>(
  lease: VaultAuthorityLease,
  prepared: PreparedAuthorityRead<T>,
): Promise<T> {
  const reader = lease.disclose(prepared).getReader();
  try {
    const first = await reader.read();
    assertEquals(first.done, false);
    assertEquals(await reader.read(), { done: true, value: undefined });
    return first.value!;
  } finally {
    reader.releaseLock();
  }
}
import { createInstanceAuth } from "../server/auth/middleware.ts";
import {
  GUEST,
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { VaultConfigStore } from "../server/config/vault.ts";
import { BoundFileStore } from "../server/config/file_store.ts";
import { GlobalConfig } from "./helpers/config.ts";
import { testEnvironment } from "./helpers/environment.ts";
import {
  identityFixture,
  UPDATE,
  VAULT_A,
  VAULT_B,
} from "./helpers/identity.ts";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { OwnershipError } from "../shared/ownership.js";

Deno.test("P05 selector retirement cannot authorize the same vault after retiring its parent", () =>
  fixture(async (f) => {
    let retire = false;
    const authority = new InstanceAuthority(f.sessions, () => {
      if (retire) f.lifetime.retire();
      return f.target;
    }, f.lifetime.lease);
    const lease = authority.lease(f.token.principal, "readVault");
    const prepared = lease.prepare("private");
    assertEquals(await delivered(lease, prepared), "private");
    const queued = lease.disclose(prepared).getReader();
    retire = true;
    try {
      await assertRejects(
        () => queued.read(),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      queued.releaseLock();
    }
  }));

Deno.test("P05 instance policy checks cannot retire the parent then authorize an effect", () =>
  fixture(async (f) => {
    const guard = await f.auth.instanceGuard(f.request(), "manageOwnAccount");
    guard();
    const current = f.sessions.assertCurrent.bind(f.sessions);
    f.sessions.assertCurrent = (principal) => {
      current(principal);
      f.lifetime.retire();
    };
    assertThrows(() => guard(), OwnershipError, "Owner is retired");
  }));

Deno.test("P05 queued disclosure retains a handle until the actual consumer enqueue", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    const value = { private: "bytes" };
    const prepared = lease.prepare(value);
    assertStrictEquals(await delivered(lease, prepared), value);
    const queued = lease.disclose(prepared);
    assert(queued instanceof ReadableStream);
    f.lifetime.retire();
    const reader = queued.getReader();
    try {
      await assertRejects(
        () => reader.read(),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      reader.releaseLock();
    }
  }));

Deno.test("P05 delivery inspects a mutable getter before the final parent fence", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    let retire = false, reads = 0;
    const value = {
      get then() {
        reads++;
        if (retire) f.lifetime.retire();
        return undefined;
      },
    };
    const prepared = lease.prepare(value);
    const current = lease.disclose(prepared).getReader();
    try {
      const first = await current.read();
      assertEquals(first.done, false);
      assertStrictEquals(first.value, value);
      assertEquals(await current.read(), { done: true, value: undefined });
    } finally {
      current.releaseLock();
    }
    assertEquals(reads, 3);
    const queued = lease.disclose(prepared).getReader();
    reads = 0;
    retire = true;
    try {
      await assertRejects(
        () => queued.read(),
        OwnershipError,
        "Owner is retired",
      );
      assertEquals(reads, 2);
    } finally {
      queued.releaseLock();
    }
  }));

for (const path of ["vault", "instance"] as const) {
  Deno.test(`P05 ${path} credential cache follows the admitted session owner with a reused request`, () =>
    fixture(async (f) => {
      const request = f.request();
      const replacement = new InstanceSessions(
        f.accounts,
        new SessionRepository(`${f.root}/identity`),
        { expirySeconds: 1000 },
        { now: () => NOW },
      );
      const signing = new SessionRepository(`${f.root}/replacement-signing`);
      signing.initialize();
      assertEquals(
        signing.capture().value.signingRevision,
        f.token.principal.signingRevision,
      );
      const foreignKeyOwner = new InstanceSessions(f.accounts, signing, {
        expirySeconds: 1000,
      }, { now: () => NOW });
      const calls = [0, 0, 0];
      const firstResolve = f.sessions.resolve.bind(f.sessions);
      const secondResolve = replacement.resolve.bind(replacement);
      const foreignResolve = foreignKeyOwner.resolve.bind(foreignKeyOwner);
      foreignKeyOwner.resolve = (token) => {
        calls[2]++;
        return foreignResolve(token);
      };
      f.sessions.resolve = (token) => {
        calls[0]++;
        return firstResolve(token);
      };
      replacement.resolve = (token) => {
        calls[1]++;
        return secondResolve(token);
      };
      const admit = () =>
        path === "vault"
          ? f.auth.readLease(request)
          : f.auth.instanceGuard(request, "manageOwnAccount");
      await Promise.all([admit(), admit()]);
      f.authAdapters.sessions = replacement;
      await Promise.all([admit(), admit()]);
      f.authAdapters.sessions = foreignKeyOwner;
      const first = admit(), second = admit();
      first.catch(() => {});
      second.catch(() => {});
      await assertRejects(
        () => first,
        HttpError,
        "HTTP 401",
      );
      await assertRejects(
        () => second,
        HttpError,
        "HTTP 401",
      );
      assertEquals(calls, [1, 1, 1]);
    }));
}

Deno.test("P05 cancellation starts locked and cleanup rejection preserves the original stream error", () =>
  fixture(async (f) => {
    const primary = new Error("original authority error"),
      cleanup = new Error("cleanup error");
    let fail = false;
    const parent = createOperationLease("live", [() => {
      if (fail) throw primary;
    }]);
    const authority = new InstanceAuthority(
      f.sessions,
      () => f.target,
      parent.lease,
    );
    const lease = authority.lease(f.token.principal, "readVault");
    const locks: boolean[] = [];
    const source = new ReadableStream<string>({
      cancel() {
        locks.push(source.locked);
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const reader = lease.stream(source).getReader();
    fail = true;
    try {
      const error = await assertRejects(
        () => reader.read(),
        Error,
        "original authority error",
      );
      assertStrictEquals(error, primary);
      assertEquals([locks, source.locked], [[true], false]);
    } finally {
      parent.retire();
      reader.releaseLock();
    }
  }));

for (const mode of ["error", "cancel"] as const) {
  Deno.test(`P05 tee ${mode} releases the source lock while its peer stays open`, () =>
    fixture(async (f) => {
      const lease = await f.auth.readLease(f.request());
      const entered = fixtureGate(f.owner), release = fixtureGate(f.owner);
      const cleanupError = new Error("source cleanup failed");
      let cancellations = 0;
      const source = new ReadableStream<string>({
        async pull(controller) {
          entered.resolve();
          await release.promise;
          controller.enqueue("secret");
        },
        cancel() {
          cancellations++;
          throw cleanupError;
        },
      }, { highWaterMark: 0 });
      const [branch, peer] = source.tee();
      const reader = lease.stream(branch).getReader();
      try {
        if (mode === "error") {
          const pending = reader.read();
          pending.catch(() => {});
          await workMilestone(
            pending,
            entered.promise,
            "tee source read entered",
          );
          f.lifetime.retire();
          release.resolve();
          await assertRejects(
            () => pending,
            OwnershipError,
            "Owner is retired",
          );
        } else {
          await reader.cancel("stop");
        }
        assertEquals([branch.locked, peer.locked, cancellations], [
          false,
          false,
          0,
        ]);
        // Closing the open peer settles the already-observed branch cancellation.
        const error = await assertRejects(
          () => peer.cancel("peer done"),
          Error,
          "source cleanup failed",
        );
        assertStrictEquals(error, cleanupError);
        assertEquals(cancellations, 1);
      } finally {
        release.resolve();
        reader.releaseLock();
      }
    }));
}

const NOW = 1_800_000_000_000;
Deno.test("P05 response body consumes its prepared handle only while the owner is current", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    const prepared = lease.prepare(
      new TextEncoder().encode("private response bytes"),
    );
    assertEquals(
      await new Response(lease.disclose(prepared)).text(),
      "private response bytes",
    );
    const queued = new Response(lease.disclose(prepared));
    f.lifetime.retire();
    await assertRejects(
      () => queued.text(),
      OwnershipError,
      "Owner is retired",
    );
  }));

async function identities(root: string, owner: FixtureScope) {
  const accounts = new AccountRepository(`${root}/identity`);
  const alice = importFixtureAccount(
    accounts,
    await prepareFixtureAccount("alice", "password"),
  );
  const bob = importFixtureAccount(
    accounts,
    await prepareFixtureAccount("bob", "password"),
  );
  const signing = new SessionRepository(`${root}/identity`);
  signing.initialize();
  let now = NOW;
  const sessions = new InstanceSessions(accounts, signing, {
    expirySeconds: 1000,
  }, { now: () => now });
  const token = await signIn(sessions, {
    username: "alice",
    password: "password",
  });
  const credentialWrites: Promise<unknown>[] = [];
  owner.onCancel(() => accounts.retireCredentials());
  owner.defer(() => Promise.all(credentialWrites));
  const revokeCredentials = (id: string) => {
    const completion = owner.admit(() =>
      disableFixtureAuthenticator(accounts, id, UPDATE)
    );
    completion.catch(() => {});
    credentialWrites.push(completion);
  };
  return {
    credentialWrites,
    revokeCredentials,
    accounts,
    alice,
    bob,
    sessions,
    token,
    expire: () => {
      now = NOW + 1_000_000;
    },
  };
}
async function fixture(
  run: (f: Awaited<ReturnType<typeof scope>>) => Promise<void>,
) {
  await identityFixture(async (root, owner) => {
    const f = await scope(root, owner);
    owner.onCancel(() => f.lifetime.retire());
    await run(f);
  });
}
async function scope(root: string, owner: FixtureScope) {
  const base = await identities(root, owner),
    vaultPath = `${root}/notes`,
    metadata = `${root}/meta`;
  Deno.mkdirSync(vaultPath);
  const config = new GlobalConfig(testEnvironment({
    GLOBNOTES_GLOBNOTES_PATH: vaultPath,
    fixtureStatePath: metadata,
    fixtureAuth: { auth_type: "none" },
  }));
  const lifecycle = new PluginLifecycle(config);
  const acl = new AclRepository(metadata, VAULT_A, { accounts: base.accounts });
  acl.initializeForCreator(base.alice, "none");
  const target: AuthorityVault = { identity: {}, id: VAULT_A, acl, lifecycle };
  let selected: AuthorityVault | null = target;
  const lifetime = createOperationLease("live", [() => {}]);
  const authority = new InstanceAuthority(
    base.sessions,
    () => selected,
    lifetime.lease,
  );
  const authAdapters = {
    sessions: base.sessions,
    vault: () => selected,
    cookieName: "fixture-token",
    lifetime: () => lifetime.lease,
  };
  const auth = createInstanceAuth(authAdapters);
  const request = (
    method = "POST",
    headers: HeadersInit = {
      authorization: `Bearer ${base.token.access_token}`,
    },
  ) => new Request("http://fixture/_/api/render", { method, headers });
  const policy = (values: AclValues) =>
    acl.save(values, acl.capture(), {
      updateId: UPDATE,
      actorId: base.alice.id,
    });
  return {
    ...base,
    owner,
    root,
    metadata,
    acl,
    lifecycle,
    lifetime,
    target,
    authority,
    auth,
    authAdapters,
    config,
    request,
    policy,
    select: (value: AuthorityVault | null) => {
      selected = value;
    },
  };
}

Deno.test("identity authority: capabilities implement the level matrix, not method or token presence", () =>
  fixture(async (f) => {
    const bob =
      (await signIn(f.sessions, { username: "bob", password: "password" }))
        .principal;
    for (const grant of ["none", "view", "edit", "admin"] as const) {
      f.policy({ everybody: "view", grants: { [f.alice.id]: grant } });
      const caps = f.authority.capabilities(f.token.principal);
      assertEquals([caps.canRead, caps.canEdit, caps.canManageVault], [
        grant !== "none",
        grant === "edit" || grant === "admin",
        grant === "admin",
      ]);
      assertEquals(f.authority.capabilities(bob).canRead, true);
      assertEquals(f.authority.capabilities(GUEST).canManageVault, false);
    }
    f.policy({ everybody: "none", grants: { [f.alice.id]: "view" } });
    const renderLease = await f.auth.readLease(f.request("POST"));
    assertEquals(
      await delivered(renderLease, renderLease.prepare("rendered")),
      "rendered",
    );
    await assertRejects(
      () => f.auth.noteMutationLease(f.request("GET")),
      HttpError,
    );
    f.authority.instanceGuard(f.token.principal, "createVault")();
    assertThrows(
      () => f.authority.instanceGuard(GUEST, "createVault"),
      HttpError,
    );
    f.select(null);
    f.authority.instanceGuard(bob, "manageOwnAccount")();
    assertEquals(f.authority.capabilities(bob).canCreateVault, true);
    assertThrows(() => f.authority.lease(bob, "readVault"), HttpError);
  }));

Deno.test("identity authority: temporary accounts can only manage themselves", () =>
  fixture(async (f) => {
    const recipient = importFixtureAccount(
      f.accounts,
      await prepareFixtureAccount("recipient", "temporary", {
        temporary: true,
      }),
    );
    f.policy({ everybody: "edit", grants: { [recipient.id]: "admin" } });
    const principal = (await signIn(f.sessions, {
      username: "recipient",
      password: "temporary",
    }))
      .principal;
    assertEquals(f.authority.capabilities(principal), {
      canRead: false,
      canEdit: false,
      canManageVault: false,
      canManageOwnAccount: true,
      canCreateVault: false,
    });
    f.authority.instanceGuard(principal, "manageOwnAccount")();
    for (const op of ["readVault", "editNotes", "manageVault"] as const) {
      assertThrows(() => f.authority.lease(principal, op), HttpError);
    }
    assertThrows(
      () => f.authority.instanceGuard(principal, "createVault"),
      HttpError,
    );
  }));

Deno.test("identity middleware: verification is once per request, while credential revisions remain live", () =>
  fixture(async (f) => {
    let calls = 0;
    const resolve = f.sessions.resolve.bind(f.sessions);
    f.sessions.resolve = (token) => {
      calls++;
      return resolve(token);
    };
    const request = f.request();
    await Promise.all([
      f.auth.principal(request),
      f.auth.readLease(request),
      f.auth.noteMutationLease(request),
    ]);
    assertEquals(calls, 1);
    await disableFixtureAuthenticator(f.accounts, f.alice.id, UPDATE);
    await assertRejects(() => f.auth.principal(request), HttpError);
    assertEquals(calls, 1);
  }));

Deno.test("identity middleware: explicit bad headers/cookies never fall back to guest or another credential", () =>
  fixture(async (f) => {
    const goodCookie = `fixture-token=${f.token.access_token}`;
    const attempts: Record<string, string>[] = [
      { authorization: "Basic invalid", cookie: goodCookie },
      { authorization: "Bearer invalid", cookie: goodCookie },
      { authorization: "", cookie: goodCookie },
      { cookie: "fixture-token=" },
      { cookie: `${goodCookie}; ${goodCookie}` },
    ];
    for (const headers of attempts) {
      const error = await assertRejects(
        () => f.auth.principal(f.request("GET", headers)),
        HttpError,
      );
      assertEquals(error.status, 401);
    }
    const cookiePrincipal = await f.auth.principal(
      f.request("GET", { cookie: goodCookie }),
    );
    assertEquals(cookiePrincipal.kind, "account");
    assertEquals(
      await f.auth.principal(
        f.request("GET", { cookie: "other-prefix-token=bad" }),
      ),
      GUEST,
    );
    const explicit = await f.auth.principal(
      f.request("GET", {
        authorization: `Bearer ${f.token.access_token}`,
        cookie: "fixture-token=invalid",
      }),
    );
    assertEquals(explicit.kind, "account");
  }));

Deno.test("identity review 1: fresh projections retain the same bundle lease", () =>
  fixture(async (f) => {
    const authority = new InstanceAuthority(
      f.sessions,
      () => ({ ...f.target }),
      f.lifetime.lease,
    );
    const lease = authority.lease(f.token.principal, "editNotes");
    lease.assertCurrent();
    assertEquals(
      await delivered(
        lease,
        await lease.read(() => Promise.resolve("same bundle bytes")),
      ),
      "same bundle bytes",
    );
    assertEquals(
      await delivered(lease, lease.prepare("same bundle response")),
      "same bundle response",
    );
  }));

Deno.test("identity review 1: a real bundle replacement conflicts even with the same vault id", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    f.select({
      ...f.target,
      identity: {},
    });
    const error = assertThrows(
      () => lease.assertCurrent(UPDATE),
      OperationError,
    );
    assertEquals(error.operationId, UPDATE);
  }));

Deno.test("identity review 2: Bearer accepts ASCII separator spaces without credential fallback", () =>
  fixture(async (f) => {
    for (const separator of [" ", "  ", "     "]) {
      const principal = await f.auth.principal(f.request("GET", {
        authorization: `bEaReR${separator}${f.token.access_token}`,
        cookie: "fixture-token=invalid",
      }));
      assertEquals(principal.kind, "account");
    }
    for (
      const authorization of [
        "Basic invalid",
        "Bearer",
        "Bearer ",
        "Bearer\tinvalid",
        "Bearer a b",
        "Bearer a,b",
        "Bearer =bad",
        "Bearer bad=tail",
      ]
    ) {
      const error = await assertRejects(
        () =>
          f.auth.principal(f.request("GET", {
            authorization,
            cookie: `fixture-token=${f.token.access_token}`,
          })),
        HttpError,
      );
      assertEquals(error.status, 401);
    }
  }));

Deno.test("identity review 3: malformed credential cookie is rejected, unrelated cookies are ignored", () =>
  fixture(async (f) => {
    const good = `fixture-token=${f.token.access_token}`;
    for (
      const cookie of [
        "fixture-token",
        `other; fixture-token`,
        `${good}; fixture-token`,
        `fixture-token; ${good}`,
        "fixture-token=",
        "fixture-token=%ZZ",
      ]
    ) {
      const error = await assertRejects(
        () => f.auth.principal(f.request("GET", { cookie })),
        HttpError,
      );
      assertEquals(error.status, 401);
    }
    assertEquals(
      await f.auth.principal(
        f.request("GET", { cookie: "other; fixture-token-extra; another=%ZZ" }),
      ),
      GUEST,
    );
    assertEquals(
      (await f.auth.principal(f.request("GET", { cookie: `other; ${good}` })))
        .kind,
      "account",
    );
  }));

Deno.test("identity authority: expiry, credential changes, ACL and bundle replacement retire captured leases", () =>
  fixture(async (f) => {
    const lease = await f.auth.noteMutationLease(f.request());
    const bob =
      (await signIn(f.sessions, { username: "bob", password: "password" }))
        .principal;
    const otherAcl = new AclRepository(`${f.root}/other`, VAULT_B, {
      accounts: f.accounts,
      declaredAdmin: "bob",
    });
    const other: AuthorityVault = {
      identity: {},
      id: VAULT_B,
      acl: otherAcl,
      lifecycle: f.lifecycle,
    };
    const otherAuthority = new InstanceAuthority(
      f.sessions,
      () => other,
      f.lifetime.lease,
    );
    const otherLease = otherAuthority.lease(bob, "manageVault");
    f.policy({ everybody: "none", grants: { [f.alice.id]: "view" } });
    otherLease.assertCurrent();
    const error = assertThrows(
      () => lease.assertCurrent(UPDATE),
      OperationError,
    );
    assertEquals(error.operationId, UPDATE);
    const fresh = await f.auth.readLease(f.request());
    await disableFixtureAuthenticator(f.accounts, f.bob.id, UPDATE);
    fresh.assertCurrent();
    assertThrows(() => otherLease.assertCurrent(), HttpError);
    f.select({ ...f.target, identity: {} });
    assertThrows(() => fresh.assertCurrent(), OperationError);
    f.select(f.target);
    const expiring = await f.auth.readLease(f.request());
    f.expire();
    assertThrows(() => expiring.assertCurrent(), HttpError);
  }));

Deno.test("identity authority: late read and actual streamed disclosure stop at revocation", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request()),
      held = fixtureGate(f.owner);
    Deno.writeTextFileSync(`${f.root}/note.md`, "private bytes");
    const observed: string[] = [];
    const reading = lease.read(async () => {
      await held.promise;
      return Deno.readTextFileSync(`${f.root}/note.md`);
    })
      .then(async (value) => {
        observed.push(await delivered(lease, value));
      });
    reading.catch(() => {});
    f.policy({ everybody: "none", grants: {} });
    held.resolve();
    await assertRejects(() => reading, OperationError);
    assertEquals(observed, []);

    f.policy({ everybody: "none", grants: { [f.alice.id]: "view" } });
    const streamLease = await f.auth.readLease(f.request());
    const release = fixtureGate(f.owner);
    const entered = fixtureGate(f.owner);
    let cancelled = false;
    const source = new ReadableStream<string>({
      async pull(controller) {
        entered.resolve();
        await release.promise;
        controller.enqueue("private stream bytes");
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const reader = streamLease.stream(source).getReader(),
      result = reader.read();
    result.catch(() => {});
    await workMilestone(result, entered.promise, "held stream pull");
    f.policy({ everybody: "none", grants: {} });
    release.resolve();
    await assertRejects(() => result, OperationError);
    reader.releaseLock();
    assertEquals(cancelled, true);
  }));

for (const revoke of [false, true]) {
  Deno.test(`identity authority: settings guard ${revoke ? "rejects revoked" : "permits unchanged"} authority at real TOML persistence`, () =>
    fixture(async (f) => {
      const guard = await f.auth.settingsWriteGuard(f.request());
      const settings = new VaultConfigStore(
        "globnotes",
        `${f.metadata}/config.toml`,
      );
      const before = settings.capture(),
        raw = new BoundFileStore(`${f.metadata}/config.toml`).capture().raw;
      const events: string[] = [];
      const saving = () =>
        settings.save({ brand: { name: "updated" } }, before, () => {
          events.push(events.length === 0 ? "admission" : "persistence");
          guard();
          if (events.length === 1) {
            events.push("admitted");
            if (revoke) {
              f.policy({ everybody: "none", grants: { [f.alice.id]: "edit" } });
              events.push("revoked");
            }
          }
        });
      if (revoke) {
        const error = assertThrows(
          saving,
          OperationError,
          "Access policy changed while this operation was pending; it was not applied.",
        );
        assertEquals([error.status, error.code, error.message], [
          409,
          "operation_conflict",
          "Access policy changed while this operation was pending; it was not applied.",
        ]);
        assertEquals(events, [
          "admission",
          "admitted",
          "revoked",
          "persistence",
        ]);
        assertStrictEquals(settings.capture(), before);
        assertEquals(new BoundFileStore(settings.filename).capture().raw, raw);
      } else {
        const expected = {
          ...before.resolved.config,
          brand: { ...before.resolved.config.brand, name: "updated" },
        };
        assertEquals(saving(), expected);
        assertEquals(settings.settings, expected);
        assertEquals(events, ["admission", "admitted", "persistence"]);
        assertEquals(settings.capture().saved, { brand: { name: "updated" } });
        assertEquals(
          new VaultConfigStore("globnotes", settings.filename).settings,
          expected,
        );
      }
    }));
}

const P05_CHANGES = [
  "bundle",
  "acl-owner",
  "lifecycle-owner",
  "epoch",
  "policy",
  "credentials",
  "expiry",
  "composition",
  "sessions",
  "abort",
  "same-wrapper",
] as const;
type P05Change = typeof P05_CHANGES[number];
function replaceP05Owner(
  f: Awaited<ReturnType<typeof scope>>,
  change: P05Change,
  abort: AbortController,
) {
  switch (change) {
    case "bundle":
      f.select({ ...f.target, identity: {} });
      break;
    case "acl-owner":
      f.select({
        ...f.target,
        acl: new AclRepository(f.metadata, VAULT_A, { accounts: f.accounts }),
      });
      break;
    case "lifecycle-owner":
      f.select({ ...f.target, lifecycle: new PluginLifecycle(f.config) });
      break;
    case "epoch":
      f.lifecycle.bumpEpoch();
      break;
    case "policy":
      // Keep this caller authorized: only the captured policy changed.
      f.policy({ everybody: "view", grants: { [f.alice.id]: "admin" } });
      break;
    case "credentials":
      f.revokeCredentials(f.alice.id);
      break;
    case "expiry":
      f.expire();
      break;
    case "composition":
      f.lifetime.retire();
      break;
    case "sessions":
      f.authAdapters.sessions = new InstanceSessions(
        f.accounts,
        f.sessions.signing,
        { expirySeconds: 1000 },
        { now: () => NOW },
      );
      break;
    case "abort":
      abort.abort(new Error("P05 request retired"));
      break;
    case "same-wrapper":
      f.select({ ...f.target });
      break;
  }
}

for (const change of P05_CHANGES) {
  Deno.test(`P05 authority admission: ${change} during validation cannot borrow a later owner or read a body`, () =>
    fixture(async (f) => {
      const entered = fixtureGate(f.owner);
      const held = fixtureGate(f.owner);
      const abort = new AbortController();
      const request = new Request(f.request(), { signal: abort.signal });
      const resolve = f.sessions.resolve.bind(f.sessions);
      f.sessions.resolve = async (token) => {
        const principal = await resolve(token);
        entered.resolve();
        await held.promise;
        return principal;
      };
      let bodies = 0;
      const admitted = f.auth.readLease(request).then(async (lease) =>
        delivered(
          lease,
          await lease.read(() => {
            bodies++;
            return Promise.resolve("private body");
          }),
        )
      );
      admitted.catch(() => {});
      try {
        await workMilestone(admitted, entered.promise, "P05 token validation");
        replaceP05Owner(f, change, abort);
        held.resolve();
        if (change === "same-wrapper") {
          assertEquals(await admitted, "private body");
          assertEquals(bodies, 1);
        } else {
          await assertRejects(() => admitted);
          assertEquals(bodies, 0);
        }
      } finally {
        held.resolve();
        await admitted.catch(() => {});
      }
    }));

  Deno.test(`P05 authority sink: ${change} after preparation prevents final value and chunk disclosure`, () =>
    fixture(async (f) => {
      const abort = new AbortController();
      const request = new Request(f.request(), { signal: abort.signal });
      const lease = await f.auth.readLease(request);
      const entered = fixtureGate(f.owner);
      const held = fixtureGate(f.owner);
      const disclosed: string[] = [];
      const next = lease.prepare("next bytes");
      const sourceEntered = fixtureGate(f.owner);
      let cancelled = false;
      const source = new ReadableStream<string>({
        async pull(controller) {
          sourceEntered.resolve();
          await held.promise;
          controller.enqueue("private stream bytes");
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      const reader = lease.stream(source).getReader();
      const chunk = reader.read();
      chunk.catch(() => {});
      const preparing = lease.read(async () => {
        entered.resolve();
        await held.promise;
        return "private prepared bytes";
      }).then(async (value) => {
        disclosed.push(await delivered(lease, value));
      });
      preparing.catch(() => {});
      try {
        await workMilestone(preparing, entered.promise, "P05 read preparation");
        await workMilestone(
          chunk,
          sourceEntered.promise,
          "P05 chunk preparation",
        );
        replaceP05Owner(f, change, abort);
        // A real continuation boundary before the consumer, not only a source scan.
        await Promise.resolve();
        held.resolve();
        if (change === "same-wrapper") {
          await preparing;
          assertEquals(await delivered(lease, next), "next bytes");
          assertEquals(disclosed, ["private prepared bytes"]);
          assertEquals(await chunk, {
            value: "private stream bytes",
            done: false,
          });
        } else {
          await assertRejects(() => preparing);
          assertThrows(() => lease.disclose(next));
          assertEquals(disclosed, []);
          await assertRejects(() => chunk);
          assertEquals(cancelled, true);
          let bodies = 0;
          await assertRejects(() =>
            lease.read(() => {
              bodies++;
              return Promise.resolve("retired read");
            })
          );
          assertEquals(bodies, 0);
        }
      } finally {
        held.resolve();
        await preparing.catch(() => {});
        await chunk.catch(() => {});
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }));
}

for (const kind of ["Promise", "thenable"] as const) {
  Deno.test(`P05 authority stream: ${kind} chunks retain their identity without inspection`, () =>
    fixture(async (f) => {
      const lease = await f.auth.readLease(f.request());
      let thenReads = 0;
      const chunk = kind === "Promise" ? Promise.resolve("private bytes") : {
        get then() {
          thenReads++;
          return () => {
            throw new Error("A stream chunk must not be awaited");
          };
        },
      };
      const source = new ReadableStream<typeof chunk>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const reader = lease.stream(source).getReader();
      try {
        const first = await reader.read();
        assertEquals(first.done, false);
        assertStrictEquals(first.value, chunk);
        assertEquals(await reader.read(), { done: true, value: undefined });
        assertEquals(thenReads, 0);
      } finally {
        reader.releaseLock();
      }
      assertEquals(source.locked, false);
    }));
}

Deno.test("P05 authority stream: reentrant source retirement cannot enqueue a prepared chunk", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    let pulled = 0, cancelled = 0;
    const source = new ReadableStream<string>({
      pull(controller) {
        pulled++;
        controller.enqueue("first private bytes");
        f.lifetime.retire();
      },
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    const reader = lease.stream(source).getReader();
    try {
      await assertRejects(() => reader.read());
      assertEquals(pulled, 1);
      assertEquals(cancelled, 1);
    } finally {
      reader.releaseLock();
    }
  }));

Deno.test("P05 authority stream: first consumer retirement prevents the next source read", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    let pulls = 0;
    const seen: string[] = [];
    const source = new ReadableStream<string>({
      pull(controller) {
        controller.enqueue(`chunk-${++pulls}`);
      },
    }, { highWaterMark: 0 });
    const reader = lease.stream(source).getReader();
    try {
      const first = await reader.read();
      seen.push(first.value!);
      f.lifetime.retire();
      await assertRejects(() => reader.read());
      assertEquals(seen, ["chunk-1"]);
      assertEquals(pulls, 1);
    } finally {
      reader.releaseLock();
    }
  }));

Deno.test("P05 authority: public disclosure takes data, never an arbitrary final callback", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    let synchronousEntries = 0, asynchronousEntries = 0;
    assertThrows(() => {
      // @ts-expect-error The public boundary does not execute arbitrary effects.
      lease.disclose(() => {
        synchronousEntries++;
        return "effect";
      });
    }, TypeError);
    assertThrows(() => {
      // @ts-expect-error Disclosure cannot be an asynchronous preparation callback.
      lease.disclose(async () => {
        asynchronousEntries++;
        return await Promise.resolve("effect");
      });
    }, TypeError);
    assertThrows(() => {
      // @ts-expect-error Nor can a Promise be disclosed before it settles.
      lease.disclose(Promise.resolve("effect"));
    }, TypeError);
    assertEquals([synchronousEntries, asynchronousEntries], [0, 0]);
  }));

Deno.test("P05 authority: direct prepared binding requires issued live lifetime at admission and final consumer", () =>
  fixture(async (f) => {
    for (
      const binding of [
        undefined,
        { ...f.lifetime.lease },
        createOperationLease("outcome", [() => {}]).lease,
      ]
    ) {
      const authority = new InstanceAuthority(
        f.sessions,
        () => f.target,
        binding as never,
      );
      assertThrows(
        () => authority.lease(f.token.principal, "readVault"),
        TypeError,
      );
    }
    const lease = f.authority.lease(f.token.principal, "readVault");
    const prepared = lease.prepare("no bytes");
    f.lifetime.retire();
    assertThrows(() => lease.disclose(prepared));
    let preparationCalls = 0;
    await assertRejects(() =>
      lease.read(() => {
        preparationCalls++;
        return Promise.resolve("no bytes");
      })
    );
    assertEquals(preparationCalls, 0);
  }));

Deno.test("P05 authority stream: reentrant result access between validation and enqueue is fenced at actual sink", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    let cancelled = 0;
    const source = new ReadableStream<string>({
      pull(controller) {
        controller.enqueue("private chunk");
      },
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    const sourceReader = source.getReader();
    const read = sourceReader.read.bind(sourceReader);
    sourceReader.read = async () => {
      const result = await read();
      if (result.done) return result;
      return {
        done: false,
        get value() {
          f.lifetime.retire();
          return result.value;
        },
      };
    };
    source.getReader = (() => sourceReader) as typeof source.getReader;
    const reader = lease.stream(source).getReader();
    try {
      await assertRejects(() => reader.read());
      assertEquals(cancelled, 1);
    } finally {
      reader.releaseLock();
    }
  }));

Deno.test("P05 authority admission: capture does not change invalid-credential precedence for an unavailable vault", () =>
  fixture(async (f) => {
    f.select(null);
    const invalid = await assertRejects(
      () =>
        f.auth.readLease(f.request("GET", { authorization: "Bearer invalid" })),
      HttpError,
    );
    assertEquals(invalid.status, 401);
    const unavailable = await assertRejects(
      () => f.auth.readLease(f.request()),
      HttpError,
    );
    assertEquals(unavailable.status, 404);
  }));

Deno.test("P05 authority read: the promise-to-consumer microtask carries no raw private bytes", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    const reading = lease.read(() =>
      Promise.resolve("private microtask bytes")
    );
    queueMicrotask(() => f.lifetime.retire());
    const prepared = await reading;
    assertEquals(JSON.stringify(prepared), "{}");
    assertThrows(() => lease.disclose(prepared));
  }));

Deno.test("P05 authority read: forged, cloned and foreign prepared reads cannot enter a disclosure sink", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request());
    const foreign = await f.auth.readLease(f.request());
    const prepared = await lease.read(() => Promise.resolve("private bytes"));
    assertEquals(await delivered(lease, prepared), "private bytes");
    assertThrows(() => foreign.disclose(prepared), TypeError);
    assertThrows(() => lease.disclose({ ...prepared }), TypeError);
    assertThrows(() => {
      // @ts-expect-error A value is not an operation-issued prepared handle.
      lease.disclose("unsealed bytes");
    }, TypeError);
    assertThrows(() => {
      // @ts-expect-error Prepare is data-only, not an effect callback.
      lease.prepare(() => "effect");
    }, TypeError);
  }));

for (const kind of ["note", "file"] as const) {
  for (const change of ["acl", "credentials", "expiry", "unchanged"] as const) {
    fixtureTest(
      `identity authority: ${change} at a real Worker pre-hook ${
        change === "unchanged" ? "permits" : "prevents"
      } the final ${kind} effect`,
      async (scope) => {
        const release = fixtureGate(scope);
        const entered = fixtureGate(scope);
        const w = await pluginOperationsFixture({
          id: "identity-guard",
          manifest: {
            runtime: { server: "service.js" },
            hooks: ["pre-create", "pre-upload"],
            capabilities: { read: ["vault"] },
          },
          files: {
            "service.js":
              `export function activate(ctx) { for (const hook of ['pre-create','pre-upload']) ctx.hooks.on(hook, async () => { await ctx.readNote('gate'); }); }`,
          },
          fault: async (method, args, boundary) => {
            if (
              method === "readNote" && args[0] === "gate" &&
              boundary === "before"
            ) {
              entered.resolve();
              await release.promise;
            }
          },
        });
        w.scope.onCancel(() => release.resolve());
        try {
          await w.fixture.admit(async () => {
            Deno.writeTextFileSync(
              `${w.fixture.vault}/gate.md`,
              "guard fixture",
            );
            const f = await identities(w.fixture.root, w.scope);
            const acl = new AclRepository(w.fixture.statePath, VAULT_A, {
              accounts: f.accounts,
            });
            acl.initializeForCreator(f.alice, "none");
            const target = {
              identity: {},
              id: VAULT_A,
              acl,
              lifecycle: w.lifecycle,
            };
            const authority = new InstanceAuthority(
              f.sessions,
              () => target,
              createOperationLease("live", [() => {}]).lease,
            );
            const lease = authority.lease(f.token.principal, "editNotes");
            const writing = kind === "note"
              ? w.operations.createNote({
                path: "forbidden",
                content: "guarded bytes",
              }, { origin: "api", lease })
              : w.operations.uploadFile(
                "",
                "forbidden.bin",
                new TextEncoder().encode("guarded bytes"),
                { origin: "api", lease },
              );
            const filename = `${w.fixture.vault}/${
              kind === "note" ? "forbidden.md" : "forbidden.bin"
            }`;
            writing.catch(() => {});
            await workMilestone(
              writing,
              entered.promise,
              "actual Worker pre-create RPC",
            );
            // The short policy gate is available while the Worker is waiting.
            await w.lifecycle.gate.run(() => {
              if (change === "acl") {
                acl.save(
                  { everybody: "none", grants: { [f.alice.id]: "view" } },
                  acl.capture(),
                  { updateId: UPDATE, actorId: f.alice.id },
                );
              }
              if (change === "credentials") {
                f.revokeCredentials(f.alice.id);
              }
              if (change === "expiry") f.expire();
            });
            release.resolve();
            if (change === "unchanged") {
              await writing;
              assertEquals(
                Deno.readTextFileSync(filename),
                "guarded bytes",
              );
              acl.save({ everybody: "none", grants: {} }, acl.capture(), {
                updateId: UPDATE,
                actorId: f.alice.id,
              });
              assertThrows(() => lease.assertCurrent(), OperationError);
              // Revoking future authority never rolls an already committed effect back.
              assertEquals(
                Deno.readTextFileSync(filename),
                "guarded bytes",
              );
            } else {
              if (change === "acl") {
                await assertRejects(() => writing, OperationError);
              } else await assertRejects(() => writing, HttpError);
              assertThrows(
                () => Deno.statSync(filename),
                Deno.errors.NotFound,
              );
            }
            assertEquals(
              Deno.readTextFileSync(`${w.fixture.vault}/gate.md`),
              "guard fixture",
            );
          });
        } finally {
          release.resolve();
          await w.close();
        }
      },
    );
  }
}
