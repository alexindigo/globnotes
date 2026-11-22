// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { OwnAccount, ownAccountHandlers } from "../server/auth/account.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import { AuthenticationError, GUEST } from "../server/auth/sessions.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { OwnershipError } from "../shared/ownership.js";
import { createUuid } from "../shared/uuid.ts";
import {
  type CommandFixture,
  credentialCommandFixture,
  enrollmentWithBytes,
} from "./helpers/credential_commands.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  identityAccount,
  storedAccount,
  UPDATE,
} from "./helpers/identity.ts";
import {
  importFixtureAccount,
  resetFixturePassword,
} from "./helpers/account_preparation.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { heldOperation } from "./helpers/owned_operation.ts";

const authentication = "Invalid authentication credentials.";
const conflict = "Stored configuration changed before commit.";
const invalidState = "Invalid identity state; original bytes retained.";
const wire = (extra = {}) => ({
  revision: 0,
  updateId: UPDATE,
  currentPassword: "password",
  newPassword: "new password",
  ...extra,
});
const json = (body: ReadableStream) => new Response(body).json();
async function workflowFixture(
  run: (
    f: CommandFixture,
    workflow: OwnAccount,
    retire: () => boolean,
  ) => Promise<void>,
  options: Parameters<typeof credentialCommandFixture>[1] = {},
  stored: Parameters<typeof credentialCommandFixture>[2] = null,
  restricted = false,
) {
  await credentialCommandFixture(
    async (f) => {
      const lifetime = createOperationLease("live", [() => undefined]);
      const authority = new InstanceAuthority(
        f.sessions,
        () => null,
        lifetime.lease,
      );
      try {
        await run(f, new OwnAccount(authority), lifetime.retire);
      } finally {
        lifetime.retire();
      }
    },
    options,
    stored,
    restricted,
  );
}
const login = (
  f: CommandFixture,
  username = "alice",
  password = "password",
  totp?: string,
) =>
  signIn(f.sessions, {
    username,
    password,
    ...(totp === undefined ? {} : { totp }),
  });

Deno.test("own account: safe response requires an account but no vault", () =>
  workflowFixture(async (f, workflow) => {
    const token = await login(f);
    const handlers = ownAccountHandlers(
      workflow,
      () => Promise.resolve(token.principal),
    );
    const response = await handlers.get(
      new Request("http://fixture/_/api/account"),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      id: ACCOUNT_A,
      login: "alice",
      totpEnabled: false,
      credentialRevision: 0,
      passwordChangeRequired: false,
      lastUpdateId: null,
    });
    const guest = ownAccountHandlers(workflow, () => Promise.resolve(GUEST));
    const error = await assertRejects(
      () => guest.get(new Request("http://fixture/_/api/account")),
      HttpError,
      "HTTP 401",
    );
    assertEquals(error.status, 401);
    assertEquals(Object.keys(handlers).sort(), ["enrolment", "get", "patch"]);
  }));

Deno.test("own account: exact safe acknowledgment survives immediate self-revocation only for its committed change", () =>
  workflowFixture(async (f, workflow) => {
    importFixtureAccount(
      f.accounts,
      identityAccount({
        id: ACCOUNT_B,
        login: "bob",
        passwordHash: fixturePasswordHash("password"),
      }),
    );
    const token = await login(f),
      second = await login(f),
      bob = await login(f, "bob");
    const signing = Deno.readTextFileSync(`${f.root}/sessions.json`);
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await assertRejects(
      () =>
        workflow.change(token.principal, wire({ currentPassword: "wrong" })),
      AuthenticationError,
      authentication,
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    const body = await workflow.change(token.principal, wire());
    for (const old of [token, second]) {
      await assertRejects(
        () => f.sessions.validateToken(old.access_token),
        AuthenticationError,
        authentication,
      );
    }
    assertEquals(await json(body), {
      account: {
        id: ACCOUNT_A,
        login: "alice",
        totpEnabled: false,
        credentialRevision: 1,
        passwordChangeRequired: false,
        lastUpdateId: UPDATE,
      },
      requiresLogin: true,
      updateId: UPDATE,
    });
    assertEquals(
      (await f.sessions.validateToken(bob.access_token)).accountId,
      ACCOUNT_B,
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/sessions.json`), signing);
    const current = await login(f, "alice", "new password");
    const persisted = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await assertRejects(
      () => workflow.change(token.principal, wire()),
      HttpError,
      "HTTP 401",
    );
    await assertRejects(
      () =>
        workflow.change(
          current.principal,
          wire({ revision: 1, currentPassword: "new password" }),
        ),
      StoredConfigConflict,
      conflict,
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), persisted);
    assertEquals(
      new AccountRepository(f.root).identityById(ACCOUNT_A),
      f.accounts.identityById(ACCOUNT_A),
    );
  }));

for (const committed of [false, true]) {
  Deno.test(`own account: lost reply uses ordinary sign-in with actual committed=${committed} credentials, never replay`, () =>
    workflowFixture(async (f, workflow) => {
      const token = await login(f);
      if (committed) {
        await (await workflow.change(token.principal, wire())).cancel();
      }
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      await login(f, "alice", committed ? "new password" : "password");
      await assertRejects(
        () => login(f, "alice", committed ? "password" : "new password"),
        AuthenticationError,
        authentication,
      );
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      assertEquals("outcome" in workflow, false);
    }));
}

for (const cause of ["composition", "credentials", "abort"] as const) {
  Deno.test(`own account: prepared GET/enrollment ${cause} rejects at actual response consumption`, () =>
    workflowFixture(async (f, workflow, retire) => {
      const token = await login(f), abort = new AbortController();
      const get = workflow.view(token.principal, abort.signal);
      const enrollment = await workflow.enrolment(
        token.principal,
        abort.signal,
      );
      if (cause === "composition") retire();
      if (cause === "credentials") {
        await resetFixturePassword(
          f.accounts,
          ACCOUNT_A,
          "replacement",
          createUuid(),
        );
      }
      const reason = new Error("request cancelled");
      if (cause === "abort") abort.abort(reason);
      for (const body of [get, enrollment]) {
        const error = await assertRejects(
          () => json(body),
          cause === "composition"
            ? OwnershipError
            : cause === "credentials"
            ? HttpError
            : Error,
          cause === "composition"
            ? "Owner is retired"
            : cause === "credentials"
            ? "HTTP 401"
            : reason.message,
        );
        if (cause === "abort") assertStrictEquals(error, reason);
      }
    }));
}

Deno.test("own account: committed acknowledgment is fenced by composition replacement", () =>
  workflowFixture(async (f, workflow, retire) => {
    const token = await login(f);
    const body = await workflow.change(token.principal, wire());
    retire();
    await assertRejects(() => json(body), OwnershipError, "Owner is retired");
    await login(f, "alice", "new password");
    assertEquals(
      storedAccount(f.accounts, ACCOUNT_A).credentialUpdateId,
      UPDATE,
    );
  }));

Deno.test("own account: cancelled committed acknowledgment retains the change but discloses nothing", () =>
  workflowFixture(async (f, workflow) => {
    const token = await login(f), abort = new AbortController();
    const body = await workflow.change(token.principal, wire(), abort.signal);
    const reason = new Error("acknowledgment request cancelled");
    abort.abort(reason);
    const error = await assertRejects(() => json(body), Error, reason.message);
    assertStrictEquals(error, reason);
    await login(f, "alice", "new password");
    assertEquals(
      storedAccount(f.accounts, ACCOUNT_A).credentialUpdateId,
      UPDATE,
    );
  }));

Deno.test("own account: PATCH captures its cancellation signal once before the body wait", () =>
  workflowFixture(async (f, workflow) => {
    const token = await login(f), abort = new AbortController();
    const request = new Request("http://fixture/_/api/account", {
      method: "PATCH",
      body: "{}",
    });
    let reads = 0;
    Object.defineProperty(request, "signal", {
      get() {
        reads++;
        return reads === 1 ? abort.signal : new AbortController().signal;
      },
    });
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await heldOperation({
      label: "captured PATCH signal",
      progress: { kind: "controlled", clock: "manual" },
      owner: () => request,
    }, (hold) => {
      request.json = async () => {
        await hold();
        return wire();
      };
      return workflow.patch(token.principal, request);
    }, async (held) => {
      await held.reached();
      abort.abort(new Error("original request cancelled"));
      await assertRejects(
        () => held.result(),
        Error,
        "original request cancelled",
      );
      assertEquals(reads, 1);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    });
  }));

Deno.test("own account: first enrollment cannot overwrite another real authenticator change during hashing", async () => {
  let hash = (password: string) =>
    Promise.resolve(fixturePasswordHash(password));
  await workflowFixture(async (f, workflow) => {
    const token = await login(f);
    const first = await json(await workflow.enrolment(token.principal));
    const firstWire = wire({
      totp: {
        enabled: true,
        key: first.key,
        code: await f.code(first.key, "base32"),
      },
    });
    await heldOperation({
      label: "first enrollment hash",
      progress: { kind: "controlled", clock: "manual" },
      owner: () => workflow,
    }, (hold) => {
      hash = async (password) => {
        await hold();
        return fixturePasswordHash(password);
      };
      return workflow.change(token.principal, firstWire);
    }, async (held) => {
      await held.reached();
      hash = (password) => Promise.resolve(fixturePasswordHash(password));
      const winner = await json(await workflow.enrolment(token.principal));
      const updateId = createUuid();
      await json(
        await workflow.change(token.principal, {
          revision: 0,
          updateId,
          currentPassword: "password",
          totp: {
            enabled: true,
            key: winner.key,
            code: await f.code(winner.key, "base32"),
          },
        }),
      );
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      await assertRejects(
        () => held.result(),
        AuthenticationError,
        authentication,
      );
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      assertEquals(
        storedAccount(new AccountRepository(f.root), ACCOUNT_A)
          .credentialUpdateId,
        updateId,
      );
      f.now += 30_000;
      await login(f, "alice", "password", await f.code(winner.key, "base32"));
    });
  }, { hash: (password) => hash(password) });
});

Deno.test("own account: issued enrollment enables, replaces and removes through current proofs and persisted restart state", () =>
  workflowFixture(async (f, workflow) => {
    let token = await login(f);
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    const first = await json(await workflow.enrolment(token.principal));
    assertEquals([first.key, first.qr], [first.secret, `qr:${first.uri}`]);
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    await assertRejects(
      () =>
        workflow.change(
          token.principal,
          wire({ totp: { enabled: true, key: first.key, code: "bad" } }),
        ),
      IdentityStateError,
      invalidState,
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    await json(
      await workflow.change(token.principal, {
        revision: 0,
        updateId: UPDATE,
        currentPassword: "password",
        totp: {
          enabled: true,
          key: first.key,
          code: await f.code(first.key, "base32"),
        },
      }),
    );
    assertEquals(
      storedAccount(f.accounts, ACCOUNT_A).totpKeyEncoding,
      "base32",
    );
    const consumed = await f.code(first.key, "base32");
    await assertRejects(
      () => login(f, "alice", "password", consumed),
      AuthenticationError,
      authentication,
    );
    f.now += 30_000;
    token = await login(
      f,
      "alice",
      "password",
      await f.code(first.key, "base32"),
    );
    f.now += 30_000;
    const replacement = await json(await workflow.enrolment(token.principal));
    await assertRejects(
      () =>
        workflow.change(token.principal, {
          revision: 1,
          updateId: createUuid(),
          currentPassword: "password",
          totp: { enabled: true, key: replacement.key, code: consumed },
        }),
      IdentityStateError,
      invalidState,
    );
    await json(
      await workflow.change(token.principal, {
        revision: 1,
        updateId: createUuid(),
        currentPassword: "password",
        currentTotp: await f.code(first.key, "base32"),
        totp: {
          enabled: true,
          key: replacement.key,
          code: await f.code(replacement.key, "base32"),
        },
      }),
    );
    f.now += 30_000;
    token = await login(
      f,
      "alice",
      "password",
      await f.code(replacement.key, "base32"),
    );
    f.now += 30_000;
    await assertRejects(
      () =>
        workflow.change(token.principal, {
          revision: 2,
          updateId: createUuid(),
          currentPassword: "password",
          totp: { enabled: false },
        }),
      AuthenticationError,
      authentication,
    );
    await json(
      await workflow.change(token.principal, {
        revision: 2,
        updateId: createUuid(),
        currentPassword: "password",
        currentTotp: await f.code(replacement.key, "base32"),
        totp: { enabled: false },
      }),
    );
    const saved = storedAccount(new AccountRepository(f.root), ACCOUNT_A);
    assertEquals([
      saved.totpKey,
      saved.lastTotpStep,
      Object.hasOwn(saved, "totpKeyEncoding"),
    ], [null, null, false]);
    await login(f);
  }));

Deno.test("own account: unissued, retired and foreign candidates leave current code unspent", () =>
  workflowFixture(
    async (f, workflow) => {
      importFixtureAccount(
        f.accounts,
        identityAccount({
          id: ACCOUNT_B,
          login: "bob",
          passwordHash: fixturePasswordHash("password"),
        }),
      );
      const bob = await login(f, "bob");
      const foreign = await json(await workflow.enrolment(bob.principal));
      const token = await login(f, "alice", "password", await f.code());
      f.now += 30_000;
      const retired = await json(await workflow.enrolment(token.principal));
      const current = await json(await workflow.enrolment(token.principal));
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      for (
        const key of [
          "A".repeat(32),
          retired.key,
          foreign.key,
          `${current.key}\0`,
        ]
      ) {
        await assertRejects(
          async () =>
            workflow.change(
              token.principal,
              wire({
                currentTotp: await f.code(),
                totp: {
                  enabled: true,
                  key,
                  code: await f.code(current.key, "base32"),
                },
              }),
            ),
          IdentityStateError,
          invalidState,
        );
        assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      }
      await login(f, "alice", "password", await f.code());
    },
    {},
    { key: "historical raw key" },
  ));

Deno.test("own account: replaced QR rendering never returns a candidate or changes active credentials", async () => {
  let render = (uri: string) => Promise.resolve(`qr:${uri}`);
  await workflowFixture(async (f, workflow) => {
    const token = await login(f),
      before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await heldOperation({
      label: "own-account QR",
      progress: { kind: "controlled", clock: "manual" },
      owner: () => workflow,
    }, (hold) => {
      render = async (uri) => {
        await hold();
        return `qr:${uri}`;
      };
      return workflow.enrolment(token.principal);
    }, async (held) => {
      await held.reached();
      render = (uri) => Promise.resolve(`qr:${uri}`);
      const current = await json(await workflow.enrolment(token.principal));
      assertEquals([current.key, current.qr], [
        current.secret,
        `qr:${current.uri}`,
      ]);
      await assertRejects(() => held.result(), StoredConfigConflict, conflict);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    });
  }, { renderQr: (uri) => render(uri) });
});

for (const cause of ["composition", "expiry", "credentials"] as const) {
  Deno.test(`own account: PATCH captures authority before body wait (${cause})`, () =>
    workflowFixture(async (f, workflow, retire) => {
      const token = await login(f),
        request = new Request("http://fixture/_/api/account", {
          method: "PATCH",
          body: "{}",
        });
      const handlers = ownAccountHandlers(
        workflow,
        () => Promise.resolve(token.principal),
      );
      await heldOperation({
        label: "own-account body",
        progress: { kind: "controlled", clock: "manual" },
        owner: () => request,
      }, (hold) => {
        request.json = async () => {
          await hold();
          return wire();
        };
        return handlers.patch(request);
      }, async (held) => {
        await held.reached();
        if (cause === "composition") retire();
        if (cause === "expiry") f.now = token.principal.expiresAt;
        if (cause === "credentials") {
          await resetFixturePassword(
            f.accounts,
            ACCOUNT_A,
            "winner password",
            createUuid(),
          );
        }
        const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
        await assertRejects(
          () => held.result(),
          cause === "composition" ? OwnershipError : HttpError,
          cause === "composition" ? "Owner is retired" : "HTTP 401",
        );
        assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      });
    }));
}

for (
  const kind of ["unchanged-key", "password", "replace", "remove"] as const
) {
  Deno.test(`own account: HTTP ${kind} cannot overwrite independently consumed current proof during hashing`, async () => {
    let hash = (password: string) =>
      Promise.resolve(fixturePasswordHash(password));
    await workflowFixture(async (f, workflow) => {
      const key = "A".repeat(32);
      const token = await login(
        f,
        "alice",
        "password",
        await f.code(key, "base32"),
      );
      f.now += 60_000;
      const currentTotp = await f.code(key, "base32", -1);
      const newCode = await f.code(key, "base32");
      const candidate = kind === "unchanged-key" || kind === "replace"
        ? await enrollmentWithBytes(
          f,
          new Uint8Array(20).fill(kind === "replace" ? 7 : 0),
        )
        : undefined;
      const totp = candidate
        ? {
          enabled: true,
          key: candidate.key,
          code: await f.code(candidate.key, "base32"),
        }
        : kind === "remove"
        ? { enabled: false }
        : undefined;
      const request = new Request("http://fixture/_/api/account", {
        method: "PATCH",
        body: JSON.stringify(wire({ currentTotp, ...(totp ? { totp } : {}) })),
      });
      const handlers = ownAccountHandlers(
        workflow,
        () => Promise.resolve(token.principal),
      );
      await heldOperation({
        label: `HTTP replay ${kind}`,
        progress: { kind: "controlled", clock: "manual" },
        owner: () => request,
      }, (hold) => {
        hash = async (password) => {
          await hold();
          return fixturePasswordHash(password);
        };
        return handlers.patch(request);
      }, async (held) => {
        await held.reached();
        assertEquals(
          storedAccount(f.accounts, ACCOUNT_A).lastTotpStep,
          Math.floor(f.now / 30_000) - 1,
        );
        const winner = await login(f, "alice", "password", newCode);
        const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
        await assertRejects(
          () => held.result(),
          AuthenticationError,
          authentication,
        );
        assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
        assertEquals(
          (await f.sessions.validateToken(winner.access_token)).accountId,
          ACCOUNT_A,
        );
        assertEquals(
          (await f.sessions.validateToken(token.access_token))
            .credentialRevision,
          0,
        );
        assertEquals(
          storedAccount(new AccountRepository(f.root), ACCOUNT_A).lastTotpStep,
          Math.floor(f.now / 30_000),
        );
      });
    }, {
      hash: (password) => hash(password),
    }, { key: "A".repeat(32), encoding: "base32" });
  });
}

for (const newPassword of [undefined, "password", "private password"]) {
  Deno.test(`own account: temporary password must actually change (${newPassword ?? "omitted"})`, () =>
    workflowFixture(
      async (f, workflow) => {
        const token = await login(f),
          before = Deno.readTextFileSync(`${f.root}/accounts.json`);
        const input = {
          revision: 0,
          updateId: UPDATE,
          currentPassword: "password",
          ...(newPassword === undefined
            ? { totp: { enabled: false } }
            : { newPassword }),
        };
        if (newPassword !== "private password") {
          await assertRejects(
            () => workflow.change(token.principal, input),
            IdentityStateError,
            invalidState,
          );
          assertEquals(
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            before,
          );
        } else {
          assertEquals(
            (await json(await workflow.change(token.principal, input))).account
              .passwordChangeRequired,
            false,
          );
          await assertRejects(
            () => f.sessions.validateToken(token.access_token),
            AuthenticationError,
            authentication,
          );
          assertEquals(
            (await login(f, "alice", newPassword)).principal
              .passwordChangeRequired,
            false,
          );
        }
      },
      {},
      null,
      true,
    ));
}

for (
  const cause of [
    "cancel",
    "expiry",
    "composition",
    "same-account",
    "other-account",
    "external",
    "rename-failure",
  ] as const
) {
  Deno.test(`own account: held hash ${cause} observes the original workflow and final bytes`, async () => {
    let hash = (password: string) =>
      Promise.resolve(fixturePasswordHash(password));
    await workflowFixture(async (f, workflow, retire) => {
      importFixtureAccount(
        f.accounts,
        identityAccount({
          id: ACCOUNT_B,
          login: "bob",
          passwordHash: fixturePasswordHash("password"),
        }),
      );
      const token = await login(f),
        before = Deno.readTextFileSync(`${f.root}/accounts.json`),
        abort = new AbortController();
      const reason = new Error("cancelled credential request");
      const rename = Deno.renameSync;
      await heldOperation({
        label: `own account hash ${cause}`,
        progress: { kind: "controlled", clock: "manual" },
        owner: () => workflow,
      }, (hold) => {
        hash = async (password) => {
          await hold();
          return fixturePasswordHash(password);
        };
        return workflow.change(token.principal, wire(), abort.signal);
      }, async (held) => {
        await held.reached();
        assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
        if (cause === "cancel") abort.abort(reason);
        if (cause === "expiry") f.now = token.principal.expiresAt;
        if (cause === "composition") retire();
        if (cause === "same-account" || cause === "other-account") {
          // Use a second real command, not a raw credential patch.
          hash = (password) => Promise.resolve(fixturePasswordHash(password));
          const other = cause === "same-account"
            ? token
            : await login(f, "bob");
          const authority = new InstanceAuthority(
            f.sessions,
            () => null,
            createOperationLease("live", [() => undefined]).lease,
          );
          await json(
            await new OwnAccount(authority).change(
              other.principal,
              wire({ updateId: createUuid(), newPassword: "winner password" }),
            ),
          );
        }
        if (cause === "external") {
          Deno.writeTextFileSync(`${f.root}/accounts.json`, "external");
        }
        const unchanged = Deno.readTextFileSync(`${f.root}/accounts.json`);
        if (cause === "rename-failure") {
          Deno.renameSync = () => {
            throw new Deno.errors.PermissionDenied("fixture rename denied");
          };
        }
        try {
          if (cause === "other-account") {
            assertEquals(
              (await json(await held.result())).account.lastUpdateId,
              UPDATE,
            );
            await login(f, "alice", "new password");
            await login(f, "bob", "winner password");
          } else {
            const error = await assertRejects(
              () => held.result(),
              cause === "rename-failure"
                ? Deno.errors.PermissionDenied
                : AuthenticationError,
              cause === "rename-failure"
                ? "fixture rename denied"
                : authentication,
            );
            assertEquals(held.isProductRejection(error), true);
            assertEquals(
              Deno.readTextFileSync(`${f.root}/accounts.json`),
              unchanged,
            );
          }
        } finally {
          Deno.renameSync = rename;
        }
      });
    }, { hash: (password) => hash(password) });
  });
}

Deno.test("own account: HTTP mapping captures body ownership and rejects target fields, stale CAS and duplicate IDs", () =>
  workflowFixture(async (f, workflow) => {
    const token = await login(f);
    for (
      const input of [
        wire({ accountId: ACCOUNT_B }),
        wire({ passwordHash: "raw" }),
        wire({ totp: { enabled: false, key: "ignored" } }),
        wire({ currentTotp: 123 }),
      ]
    ) {
      const error = await assertRejects(
        () => workflow.change(token.principal, input),
        HttpError,
        "HTTP 422",
      );
      assertEquals(error.status, 422);
    }
    await assertRejects(
      () => workflow.change(token.principal, wire({ revision: 99 })),
      StoredConfigConflict,
      conflict,
    );
    const handlers = ownAccountHandlers(
      workflow,
      () => Promise.resolve(token.principal),
    );
    const response = await handlers.patch(
      new Request("http://fixture/_/api/account", {
        method: "PATCH",
        body: JSON.stringify(wire()),
      }),
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).updateId, UPDATE);
  }));

Deno.test("own account: issued effective legacy alias is confirmed through the wire without lowering the accepted floor", () =>
  workflowFixture(
    async (f, workflow) => {
      const token = await login(f, "alice", "password", await f.code());
      f.now += 30_000;
      const bytes = new Uint8Array(20);
      bytes.set(new TextEncoder().encode("key"));
      const candidate = await enrollmentWithBytes(f, bytes);
      const currentTotp = await f.code("key", undefined, 1);
      const response = await workflow.change(token.principal, {
        revision: 0,
        updateId: UPDATE,
        currentPassword: "password",
        currentTotp,
        totp: {
          enabled: true,
          key: candidate.key,
          code: await f.code(candidate.key, "base32"),
        },
      });
      assertEquals((await json(response)).account.credentialRevision, 1);
      assertEquals(
        storedAccount(f.accounts, ACCOUNT_A).lastTotpStep,
        Math.floor(f.now / 30_000) + 1,
      );
      await assertRejects(
        () => login(f, "alice", "password", currentTotp),
        AuthenticationError,
        authentication,
      );
    },
    {},
    { key: "key" },
  ));
