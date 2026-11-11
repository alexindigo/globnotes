// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { AccountRepository, prepareAccount } from "../server/auth/accounts.ts";
import { AclRepository, type AclValues } from "../server/auth/acl.ts";
import {
  type AuthorityVault,
  InstanceAuthority,
} from "../server/auth/authority.ts";
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

const NOW = 1_800_000_000_000;
async function identities(root: string) {
  const accounts = new AccountRepository(`${root}/identity`);
  const alice = accounts.create(await prepareAccount("alice", "password"));
  const bob = accounts.create(await prepareAccount("bob", "password"));
  const signing = new SessionRepository(`${root}/identity`);
  signing.initialize();
  let now = NOW;
  const sessions = new InstanceSessions(accounts, signing, {
    expirySeconds: 1000,
  }, { now: () => now });
  const token = await sessions.login({
    username: "alice",
    password: "password",
  });
  return {
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
  await identityFixture(async (root) => {
    await run(await scope(root));
  });
}
async function scope(root: string) {
  const base = await identities(root),
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
  const target: AuthorityVault = { id: VAULT_A, acl, lifecycle };
  let selected: AuthorityVault | null = target;
  const authority = new InstanceAuthority(base.sessions, () => selected);
  const auth = createInstanceAuth({
    sessions: base.sessions,
    vault: () => selected,
    cookieName: "fixture-token",
  });
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
    root,
    metadata,
    acl,
    lifecycle,
    target,
    authority,
    auth,
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
      (await f.sessions.login({ username: "bob", password: "password" }))
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
    assert(
      (await f.auth.readLease(f.request("POST"))).disclose(() => "rendered"),
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
    const recipient = f.accounts.create(
      await prepareAccount("recipient", "temporary", { temporary: true }),
    );
    f.policy({ everybody: "edit", grants: { [recipient.id]: "admin" } });
    const principal =
      (await f.sessions.login({ username: "recipient", password: "temporary" }))
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
    f.accounts.changeCredentials(f.alice.id, 0, {
      passwordChangeRequired: true,
    }, UPDATE);
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

Deno.test("identity authority: expiry, credential changes, ACL and bundle replacement retire captured leases", () =>
  fixture(async (f) => {
    const lease = await f.auth.noteMutationLease(f.request());
    const bob =
      (await f.sessions.login({ username: "bob", password: "password" }))
        .principal;
    const otherAcl = new AclRepository(`${f.root}/other`, VAULT_B, {
      accounts: f.accounts,
      declaredAdmin: "bob",
    });
    const other: AuthorityVault = {
      id: VAULT_B,
      acl: otherAcl,
      lifecycle: f.lifecycle,
    };
    const otherAuthority = new InstanceAuthority(f.sessions, () => other);
    const otherLease = otherAuthority.lease(bob, "manageVault");
    f.policy({ everybody: "none", grants: { [f.alice.id]: "view" } });
    otherLease.assertCurrent();
    const error = assertThrows(
      () => lease.assertCurrent(UPDATE),
      OperationError,
    );
    assertEquals(error.operationId, UPDATE);
    const fresh = await f.auth.readLease(f.request());
    f.accounts.changeCredentials(
      f.bob.id,
      0,
      { passwordChangeRequired: true },
      UPDATE,
    );
    fresh.assertCurrent();
    assertThrows(() => otherLease.assertCurrent(), HttpError);
    f.select({ ...f.target });
    assertThrows(() => fresh.assertCurrent(), OperationError);
    f.select(f.target);
    const expiring = await f.auth.readLease(f.request());
    f.expire();
    assertThrows(() => expiring.assertCurrent(), HttpError);
  }));

Deno.test("identity authority: late read and actual streamed disclosure stop at revocation", () =>
  fixture(async (f) => {
    const lease = await f.auth.readLease(f.request()),
      held = Promise.withResolvers<void>();
    Deno.writeTextFileSync(`${f.root}/note.md`, "private bytes");
    const observed: string[] = [];
    const reading = lease.read(async () => {
      await held.promise;
      return Deno.readTextFileSync(`${f.root}/note.md`);
    })
      .then((value) => {
        observed.push(value);
      });
    reading.catch(() => {});
    f.policy({ everybody: "none", grants: {} });
    held.resolve();
    await assertRejects(() => reading, OperationError);
    assertEquals(observed, []);

    f.policy({ everybody: "none", grants: { [f.alice.id]: "view" } });
    const streamLease = await f.auth.readLease(f.request());
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
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

Deno.test("identity authority: settings guard is rechecked after preparation at real TOML persistence", () =>
  fixture(async (f) => {
    const guard = await f.auth.settingsWriteGuard(f.request());
    const settings = new VaultConfigStore(
      "globnotes",
      `${f.metadata}/config.toml`,
    );
    const before = settings.capture(),
      raw = new BoundFileStore(`${f.metadata}/config.toml`).capture().raw;
    const held = Promise.withResolvers<void>();
    const saving = (async () => {
      await held.promise;
      return settings.save({ brand: { name: "forbidden" } }, before, guard);
    })();
    saving.catch(() => {});
    f.policy({ everybody: "none", grants: { [f.alice.id]: "edit" } });
    held.resolve();
    await assertRejects(() => saving, OperationError);
    assertEquals(settings.capture(), before);
    assertEquals(
      new BoundFileStore(`${f.metadata}/config.toml`).capture().raw,
      raw,
    );
  }));

for (const kind of ["note", "file"] as const) {
  for (const change of ["acl", "credentials", "expiry", "unchanged"] as const) {
    Deno.test(`identity authority: ${change} at a real Worker pre-hook ${change === "unchanged" ? "permits" : "prevents"} the final ${kind} effect`, async () => {
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
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
            method === "readNote" && args[0] === "gate" && boundary === "before"
          ) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      try {
        Deno.writeTextFileSync(`${w.fixture.vault}/gate.md`, "guard fixture");
        const f = await identities(w.fixture.root);
        const acl = new AclRepository(w.fixture.statePath, VAULT_A, {
          accounts: f.accounts,
        });
        acl.initializeForCreator(f.alice, "none");
        const target = { id: VAULT_A, acl, lifecycle: w.lifecycle };
        const authority = new InstanceAuthority(f.sessions, () => target);
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
            f.accounts.changeCredentials(f.alice.id, 0, {
              passwordChangeRequired: true,
            }, UPDATE);
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
      } finally {
        release.resolve();
        await w.close();
      }
    });
  }
}
