// SPDX-License-Identifier: LGPL-3.0-only
import { signIn } from "./helpers/session_delivery.ts";
import { OwnershipError } from "../shared/ownership.js";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { fixtureGate, fixtureTest } from "./helpers/fixture_coordination.ts";
import {
  AccountRepository,
  type AccountState,
} from "../server/auth/accounts.ts";
import {
  type AccountPreparationAuthority,
  type AccountPreparationRequest,
  AuthenticationError,
  type LoginProof,
  type PreparedAccount,
} from "../server/auth/account_credentials.ts";
import { type OfflineRecoveryAuthority } from "../server/auth/offline_recovery.ts";
import { IdentityFile, IdentityStateError } from "../server/auth/records.ts";
import { IdentityOwnershipError } from "../server/auth/ownership.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import {
  preparationContext,
  preparationFixture,
  recoveryForRoot,
} from "./helpers/account_preparation.ts";
import {
  credentialCommandFixture,
  NEXT_UPDATE,
} from "./helpers/credential_commands.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import { ACCOUNT_A, ACCOUNT_B, UPDATE } from "./helpers/identity.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { logger } from "../server/logger.ts";
import { AclRepository } from "../server/auth/acl.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { VAULT_A } from "./helpers/identity.ts";

const AUTHENTICATION_MESSAGE = "Invalid authentication credentials.";
const CONFLICT_MESSAGE = "Stored configuration changed before commit.";

for (const purpose of ["initial", "recipient"] as const) {
  Deno.test(`account preparation: ${purpose} domain remains a parent through final storage validation`, () =>
    preparationFixture(async (f) => {
      if (purpose === "recipient") await f.createInitial();
      const before = f.accounts.capture();
      const names = () =>
        [...Deno.readDirSync(f.root)].map((entry) => entry.name).sort();
      const files = names();
      const prepared = purpose === "initial"
        ? await f.accounts.credentials.prepareInitialAccount(
          f.authority(purpose),
          f.request(),
        )
        : await f.accounts.credentials.preparePasswordOnlyRecipient(
          f.authority(purpose),
          f.request({ login: "recipient" }),
        );
      const read = Deno.readTextFileSync;
      let staged = false;
      Deno.readTextFileSync = (file) => {
        const value = read(file);
        if (String(file).startsWith(`${f.root}/.config-`)) {
          staged = true;
          f.retire();
        }
        return value;
      };
      try {
        assertThrows(
          () =>
            f.accounts.credentials.publishPreparedAccount(prepared.prepared),
          OwnershipError,
          "Owner is retired",
        );
      } finally {
        Deno.readTextFileSync = read;
      }
      assertEquals(staged, true);
      assertStrictEquals(f.accounts.capture(), before);
      assertEquals(names(), files);
    }));
}

Deno.test("offline recovery: closing the lock owner during storage validation prevents publication", () =>
  credentialCommandFixture(async (f) => {
    const owner = recoveryForRoot(f.root);
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`),
      read = Deno.readTextFileSync;
    let staged = false;
    Deno.readTextFileSync = (file) => {
      const value = read(file);
      if (String(file).startsWith(`${f.root}/.config-`)) {
        staged = true;
        owner.close();
      }
      return value;
    };
    try {
      await assertRejects(
        () =>
          f.accounts.credentials.resetPassword(owner.authority, {
            accountId: ACCOUNT_A,
            credentialRevision: 0,
            updateId: UPDATE,
            password: "recovered",
          }),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      Deno.readTextFileSync = read;
      owner.close();
    }
    assertEquals(staged, true);
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    assertEquals(f.accounts.byId(ACCOUNT_A)?.credentialRevision, 0);
  }));

Deno.test("offline recovery: the forced change after a reset cannot keep the recovery password", () =>
  credentialCommandFixture(async (f) => {
    const owner = recoveryForRoot(f.root);
    try {
      await f.accounts.credentials.resetPassword(owner.authority, {
        accountId: ACCOUNT_A,
        credentialRevision: 0,
        updateId: UPDATE,
        password: "recovered",
      });
    } finally {
      owner.close();
    }
    const authority = f.bound();
    const change = (newPassword: string) =>
      f.accounts.credentials.changeOwn(
        authority,
        f.request({
          credentialRevision: 1,
          updateId: NEXT_UPDATE,
          current: { password: "recovered" },
          newPassword,
        }),
      );
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    await assertRejects(
      () => change("recovered"),
      IdentityStateError,
      "Invalid identity state; original bytes retained.",
    );
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    const changed = await change("permanent password");
    assertEquals(
      [changed.credentialRevision, changed.passwordChangeRequired],
      [2, false],
    );
    await assertRejects(
      () => f.accounts.credentials.authenticate("alice", "recovered"),
      AuthenticationError,
      AUTHENTICATION_MESSAGE,
    );
    await f.accounts.credentials.authenticate("alice", "permanent password");
  }));

Deno.test("offline recovery: disable preserves the password and unrestricted sign-in without a reset", () =>
  credentialCommandFixture(
    async (f) => {
      const before = f.accounts.byId(ACCOUNT_A)!,
        owner = recoveryForRoot(f.root);
      try {
        const result = await f.accounts.credentials.disableAuthenticator(
          owner.authority,
          { accountId: ACCOUNT_A, credentialRevision: 0, updateId: UPDATE },
        );
        assertEquals(
          result.passwordChangeRequired,
          before.passwordChangeRequired,
        );
        assertEquals(
          f.accounts.byId(ACCOUNT_A)!.passwordHash,
          before.passwordHash,
        );
        assertEquals(result.credentialRevision, 1);
        assertEquals(result.totpEnabled, false);
        await signIn(f.sessions, { username: "alice", password: "password" });
        await assertRejects(
          () =>
            f.accounts.credentials.disableAuthenticator(owner.authority, {
              accountId: ACCOUNT_A,
              credentialRevision: 0,
              updateId: NEXT_UPDATE,
            }),
          StoredConfigConflict,
        );
      } finally {
        owner.close();
      }
    },
    {},
    { key: "key", floor: 100 },
  ));

Deno.test("offline recovery: caller supplied credential material is rejected before effects", () =>
  preparationFixture(async (f) => {
    const account = await f.createInitial(),
      owner = f.offline(),
      before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    try {
      for (
        const extra of [
          { passwordHash: "hash" },
          { totpKey: "key" },
          { lastTotpStep: 100 },
          { totpKeyEncoding: "base32" },
          { committed: true },
        ]
      ) {
        await assertRejects(
          () =>
            f.accounts.credentials.resetPassword(owner.authority, {
              accountId: account.id,
              credentialRevision: 0,
              updateId: NEXT_UPDATE,
              password: "recovered",
              ...extra,
            }),
          IdentityStateError,
        );
      }
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
    } finally {
      owner.close();
    }
  }));

Deno.test("account preparation: a prepared handle cannot be claimed reentrantly during staging", () =>
  preparationFixture(async (f) => {
    const value = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request(),
    );
    const write = Deno.writeTextFileSync;
    let entered = false;
    Deno.writeTextFileSync = (file, data, options) => {
      write(file, data, options);
      if (!entered && String(file).startsWith(`${f.root}/.config-`)) {
        entered = true;
        assertThrows(
          () => f.accounts.credentials.publishPreparedAccount(value.prepared),
          IdentityStateError,
        );
      }
    };
    try {
      assertEquals(
        f.accounts.credentials.publishPreparedAccount(value.prepared),
        value.identity,
      );
      assert(entered);
      assertEquals(f.accounts.capture().value.accounts.length, 1);
    } finally {
      Deno.writeTextFileSync = write;
    }
  }));

fixtureTest(
  "offline recovery: independent code progress during hashing cannot be overwritten by reset",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    return credentialCommandFixture(async (f) => {
      const owner = recoveryForRoot(f.root);
      const pending = f.accounts.credentials.resetPassword(owner.authority, {
        accountId: ACCOUNT_A,
        credentialRevision: 0,
        updateId: UPDATE,
        password: "recovered",
      });
      pending.catch(() => {});
      try {
        await workMilestone(
          pending,
          entered.promise,
          "offline reset hash entered",
        );
        await signIn(f.sessions, {
          username: "alice",
          password: "password",
          totp: await f.code(),
        });
        const afterProgress = Deno.readTextFileSync(`${f.root}/accounts.json`);
        release.resolve(fixturePasswordHash("recovered"));
        await assertRejects(() => pending, AuthenticationError);
        assertEquals(
          Deno.readTextFileSync(`${f.root}/accounts.json`),
          afterProgress,
        );
      } finally {
        release.resolve(fixturePasswordHash("recovered"));
        await pending.catch(() => {});
        owner.close();
      }
    }, {
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    }, { key: "key", floor: 100 });
  },
);

Deno.test("account preparation: invalid hash output cannot become a prepared account", () =>
  preparationFixture(async (f) => {
    await assertRejects(
      () =>
        f.accounts.credentials.prepareInitialAccount(
          f.authority("initial"),
          f.request(),
        ),
      IdentityStateError,
    );
    assertEquals([...Deno.readDirSync(f.root)], []);
  }, { hash: () => Promise.resolve("invalid hash") }));

Deno.test("account preparation: production password hashing reaches normal sign-in after restart", () =>
  preparationFixture(async (f) => {
    const account = await f.createInitial();
    const reopened = new AccountRepository(f.root);
    const proof = await reopened.credentials.authenticate("alice", "password");
    assertEquals(reopened.identityById(account.id), account);
    await assertRejects(
      () => reopened.credentials.authenticate("alice", "wrong"),
      AuthenticationError,
    );
    assertEquals(Object.keys(proof), []);
  }, { hash: undefined }));

Deno.test("account preparation: initial password-only handle is inert, opaque and publishes an exact redacted identity", () =>
  preparationFixture(async (f) => {
    const result = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request({ login: " Alice " }),
    );
    assertEquals([...Deno.readDirSync(f.root)], []);
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.prepared));
    assert(Object.isFrozen(result.identity));
    assertEquals(Object.keys(result.prepared), []);
    for (const field of ["raw", "file", "publish", "passwordHash", "totpKey"]) {
      assertEquals(Object.hasOwn(result.prepared, field), false);
    }
    assertThrows(
      () => Object.assign(result.prepared, { raw: "forged" }),
      TypeError,
    );
    assertEquals(result.identity.login, "alice");
    assertEquals(result.identity.totpEnabled, false);
    assertEquals(result.identity.passwordChangeRequired, false);
    const created = f.accounts.credentials.publishPreparedAccount(
      result.prepared,
    );
    assertEquals(created, result.identity);
    assertEquals(
      new AccountRepository(f.root).identityById(created.id),
      created,
    );
    assertEquals(f.accounts.capture().value.updateId, UPDATE);
    assertEquals(f.accounts.capture().value.initialized, true);
    assertEquals(f.accounts.byId(created.id)?.lastTotpStep, null);
    f.signing.initialize();
    const token = await signIn(f.sessions, {
      username: "alice",
      password: "password",
    });
    assertEquals(
      (await f.sessions.validateToken(token.access_token)).accountId,
      created.id,
    );
    assertThrows(
      () => f.accounts.credentials.publishPreparedAccount(result.prepared),
      IdentityStateError,
    );
  }));

Deno.test("account preparation: recipient is owner-made password-only and temporary, without first-account authority", () =>
  preparationFixture(async (f) => {
    const initial = await f.createInitial();
    const prepared = await f.accounts.credentials.preparePasswordOnlyRecipient(
      f.authority("recipient"),
      f.request({ login: "bob", updateId: NEXT_UPDATE }),
    );
    assertEquals(f.accounts.byLogin("bob"), null);
    assert(prepared.identity.passwordChangeRequired);
    assert(!prepared.identity.totpEnabled);
    assert(prepared.identity.id !== initial.id);
    const recipient = f.accounts.credentials.publishPreparedAccount(
      prepared.prepared,
    );
    assertEquals(f.accounts.capture().value.accounts.length, 2);
    assertEquals(recipient, prepared.identity);
    f.signing.initialize();
    const token = await signIn(f.sessions, {
      username: "bob",
      password: "password",
    });
    assert(token.principal.passwordChangeRequired);
    await assertRejects(
      () =>
        f.accounts.credentials.prepareInitialAccount(
          f.authority("initial"),
          f.request({ login: "charlie" }),
        ),
      StoredConfigConflict,
    );
  }));

Deno.test("account preparation: forged, cloned, foreign and wrong-purpose capabilities never publish or issue sign-in", () =>
  preparationFixture(async (f) => {
    const authority = f.authority("initial");
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      authority,
      f.request(),
    );
    for (
      const value of [
        {},
        { ...authority },
        structuredClone(authority),
        prepared.prepared,
        null,
      ]
    ) {
      await assertRejects(() =>
        f.accounts.credentials.prepareInitialAccount(
          value as AccountPreparationAuthority,
          f.request(),
        ), IdentityStateError);
    }
    await assertRejects(
      () =>
        f.accounts.credentials.prepareInitialAccount(
          f.authority("recipient"),
          f.request(),
        ),
      IdentityStateError,
    );
    await assertRejects(
      () =>
        f.accounts.credentials.preparePasswordOnlyRecipient(
          authority,
          f.request(),
        ),
      IdentityStateError,
    );
    for (
      const value of [
        {},
        { ...prepared.prepared },
        structuredClone(prepared.prepared),
        authority,
        { ...prepared, committed: true },
        null,
      ]
    ) {
      assertThrows(
        () =>
          f.accounts.credentials.publishPreparedAccount(
            value as PreparedAccount,
          ),
        IdentityStateError,
      );
    }
    await preparationFixture(async (other) => {
      await assertRejects(
        () =>
          other.accounts.credentials.prepareInitialAccount(
            authority,
            other.request(),
          ),
        IdentityStateError,
      );
      assertThrows(
        () =>
          other.accounts.credentials.publishPreparedAccount(prepared.prepared),
        IdentityStateError,
      );
    });
    await assertRejects(
      () => f.sessions.issue(prepared.prepared as unknown as LoginProof),
      AuthenticationError,
    );
    f.accounts.credentials.publishPreparedAccount(prepared.prepared);
    await assertRejects(
      () => f.sessions.issue(prepared.prepared as unknown as LoginProof),
      AuthenticationError,
    );
    assertEquals(f.accounts.capture().value.accounts.length, 1);
  }));

Deno.test("account preparation: credential fields and caller-supplied publication facts are not preparation inputs", () =>
  preparationFixture(async (f) => {
    for (
      const extra of [
        { id: ACCOUNT_B },
        { passwordHash: "hash" },
        { totpKey: "key" },
        { lastTotpStep: 100 },
        { committed: true },
        { raw: "bytes" },
        { file: "other" },
        { temporary: false },
        { login: "guest" },
        { password: "" },
      ]
    ) {
      await assertRejects(() =>
        f.accounts.credentials.prepareInitialAccount(
          f.authority("initial"),
          { ...f.request(), ...extra } as AccountPreparationRequest,
        ), IdentityStateError);
    }
    assertEquals([...Deno.readDirSync(f.root)], []);
    const typeContract = () => {
      f.accounts.credentials.prepareInitialAccount(f.authority("initial"), {
        ...f.request(),
        // @ts-expect-error No raw account credential input exists on preparation.
        passwordHash: "hash",
      });
      f.accounts.credentials.publishPreparedAccount(
        // @ts-expect-error An ordinary account cannot replace the sealed handle.
        f.accounts.byId(ACCOUNT_A)!,
      );
    };
    void typeContract;
  }));

for (
  const boundary of [
    "abort",
    "domain retirement",
    "aggregate retirement",
    "competing publication",
  ] as const
) {
  fixtureTest(
    `account preparation: ${boundary} during hashing creates no stale account`,
    (scope) => {
      const entered = fixtureGate(scope),
        release = fixtureGate<string>(scope);
      let calls = 0;
      return preparationFixture(async (f) => {
        const abort = new AbortController();
        const authority = f.authority("initial");
        const pending = f.accounts.credentials.prepareInitialAccount(
          authority,
          f.request(),
          abort.signal,
        );
        pending.catch(() => {});
        try {
          await workMilestone(
            pending,
            entered.promise,
            "preparation password hash entered",
          );
          if (boundary === "abort") abort.abort();
          if (boundary === "domain retirement") f.retire();
          if (boundary === "aggregate retirement") {
            f.accounts.retireCredentials();
          }
          if (boundary === "competing publication") {
            const other = await f.accounts.credentials.prepareInitialAccount(
              authority,
              f.request({ login: "winner" }),
            );
            f.accounts.credentials.publishPreparedAccount(other.prepared);
          }
          release.resolve(fixturePasswordHash("password"));
          const [type, message] = ({
            "abort": [AuthenticationError, AUTHENTICATION_MESSAGE],
            "domain retirement": [OwnershipError, "Owner is retired"],
            "aggregate retirement": [OwnershipError, "Owner is retired"],
            "competing publication": [StoredConfigConflict, CONFLICT_MESSAGE],
          } as const)[boundary];
          await assertRejects(() => pending, type, message);
          assertEquals(f.accounts.byLogin("alice"), null);
          assertEquals(
            f.accounts.capture().value.accounts.length,
            boundary === "competing publication" ? 1 : 0,
          );
        } finally {
          release.resolve(fixturePasswordHash("password"));
          await pending.catch(() => {});
        }
      }, {
        hash: () => {
          if (++calls === 1) {
            entered.resolve();
            return release.promise;
          }
          return Promise.resolve(fixturePasswordHash("password"));
        },
      });
    },
  );
}

for (
  const boundary of [
    "retired authority",
    "equal-file replacement",
    "unpublished write failure",
    "staged-write retirement",
  ] as const
) {
  Deno.test(`account preparation: ${boundary} rejects final publication and closes the handle`, () =>
    preparationFixture(async (f) => {
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        f.authority("initial"),
        f.request(),
      );
      const write = Deno.writeTextFileSync, link = Deno.linkSync;
      let staged = false;
      try {
        if (boundary === "retired authority") f.retire();
        if (boundary === "equal-file replacement") {
          Deno.writeTextFileSync(
            `${f.root}/accounts.json`,
            JSON.stringify(f.accounts.capture().value),
          );
        }
        if (boundary === "unpublished write failure") {
          Deno.linkSync = () => {
            throw new Deno.errors.PermissionDenied("fixture publication");
          };
        }
        if (boundary === "staged-write retirement") {
          Deno.writeTextFileSync = (file, data, options) => {
            write(file, data, options);
            if (String(file).startsWith(`${f.root}/.config-`)) {
              staged = true;
              f.retire();
            }
          };
        }
        const [type, message] = ({
          "retired authority": [OwnershipError, "Owner is retired"],
          "equal-file replacement": [StoredConfigConflict, CONFLICT_MESSAGE],
          "unpublished write failure": [
            Deno.errors.PermissionDenied,
            "fixture publication",
          ],
          "staged-write retirement": [OwnershipError, "Owner is retired"],
        } as const)[boundary];
        assertThrows(
          () =>
            f.accounts.credentials.publishPreparedAccount(prepared.prepared),
          type,
          message,
        );
        assertThrows(
          () =>
            f.accounts.credentials.publishPreparedAccount(prepared.prepared),
          IdentityStateError,
        );
        assertEquals(f.accounts.capture().value.accounts.length, 0);
        if (boundary === "staged-write retirement") assert(staged);
      } finally {
        Deno.writeTextFileSync = write;
        Deno.linkSync = link;
      }
    }));
}

Deno.test("account preparation: stale first-account handle cannot append after a real winner", () =>
  preparationFixture(async (f) => {
    const authority = f.authority("initial");
    const first = await f.accounts.credentials.prepareInitialAccount(
      authority,
      f.request(),
    );
    const second = await f.accounts.credentials.prepareInitialAccount(
      authority,
      f.request({ login: "winner" }),
    );
    const winner = f.accounts.credentials.publishPreparedAccount(
      second.prepared,
    );
    assertThrows(
      () => f.accounts.credentials.publishPreparedAccount(first.prepared),
      StoredConfigConflict,
    );
    assertEquals(f.accounts.capture().value.accounts.map((a) => a.id), [
      winner.id,
    ]);
  }));

Deno.test("offline recovery: acquisition excludes another owner and release retires the opaque authority", () =>
  preparationFixture(async (f) => {
    const account = await f.createInitial();
    const owner = f.offline();
    try {
      assertThrows(() => f.offline(), IdentityOwnershipError);
      const request = {
        accountId: account.id,
        credentialRevision: 0,
        updateId: NEXT_UPDATE,
        password: "recovered",
      };
      for (
        const value of [
          {},
          { ...owner.authority },
          structuredClone(owner.authority),
          f.authority("initial"),
          null,
        ]
      ) {
        await assertRejects(() =>
          f.accounts.credentials.resetPassword(
            value as OfflineRecoveryAuthority,
            request,
          ), IdentityStateError);
      }
    } finally {
      owner.close();
    }
    await assertRejects(
      () =>
        f.accounts.credentials.resetPassword(owner.authority, {
          accountId: account.id,
          credentialRevision: 0,
          updateId: NEXT_UPDATE,
          password: "recovered",
        }),
      OwnershipError,
      "Owner is retired",
    );
    const next = f.offline();
    next.close();
    assertEquals(f.accounts.identityById(account.id)?.credentialRevision, 0);
  }));

Deno.test("offline recovery: another identity root's authority is not accepted", () =>
  preparationFixture(async (f) => {
    const account = await f.createInitial();
    await preparationFixture(async (other) => {
      const owner = other.offline();
      try {
        await assertRejects(
          () =>
            f.accounts.credentials.resetPassword(owner.authority, {
              accountId: account.id,
              credentialRevision: 0,
              updateId: NEXT_UPDATE,
              password: "recovered",
            }),
          IdentityStateError,
        );
      } finally {
        owner.close();
      }
    });
  }));

for (const mismatched of [false, true]) {
  Deno.test(`offline recovery: the injected file defines the admission root, mismatched=${mismatched}`, () =>
    credentialCommandFixture(async (f) => {
      const filename = `${f.root}/accounts.json`,
        otherRoot = `${f.root}/other-root`;
      const before = f.accounts.capture().value;
      // Trusted fixture state uses the injected persistence seam; reopened
      // AccountRepository instances below still apply the real schema validator.
      const file = new IdentityFile<AccountState>(
        filename,
        (value) => value as AccountState,
        before,
      );
      const accounts = new AccountRepository(
        mismatched ? otherRoot : f.root,
        file,
        {
          hash: (password) => Promise.resolve(fixturePasswordHash(password)),
        },
      );
      const request = {
        accountId: ACCOUNT_A,
        credentialRevision: 0,
        updateId: UPDATE,
        password: "recovered",
      };
      try {
        const originalBytes = Deno.readTextFileSync(filename);
        const wrong = recoveryForRoot(otherRoot);
        try {
          await assertRejects(
            () => accounts.credentials.resetPassword(wrong.authority, request),
            IdentityStateError,
            "Invalid identity state; original bytes retained.",
          );
        } finally {
          wrong.close();
        }
        assertEquals(Deno.readTextFileSync(filename), originalBytes);
        const right = recoveryForRoot(f.root);
        try {
          await accounts.credentials.resetPassword(right.authority, request);
        } finally {
          right.close();
        }
        assertEquals(new AccountRepository(f.root).capture().value, {
          ...before,
          revision: before.revision + 1,
          updateId: UPDATE,
          accounts: [{
            ...before.accounts[0],
            passwordHash: fixturePasswordHash("recovered"),
            passwordChangeRequired: true,
            credentialRevision: 1,
            credentialUpdateId: UPDATE,
          }],
        });
      } finally {
        accounts.retireCredentials();
      }
    }));
}

for (
  const stored of [
    { key: "key" },
    { key: "key\0", encoding: null },
    { key: "\ud800" },
    { key: "A".repeat(32) },
    { key: "A".repeat(32), encoding: "base32" as const },
    { key: "x".repeat(65) },
  ]
) {
  Deno.test(`offline recovery: reset preserves stored key, marker and floor; disable clears only that account (${JSON.stringify(stored)})`, () =>
    credentialCommandFixture(
      async (f) => {
        const before = f.accounts.byId(ACCOUNT_A)!;
        const owner = recoveryForRoot(f.root);
        try {
          const reset = await f.accounts.credentials.resetPassword(
            owner.authority,
            {
              accountId: ACCOUNT_A,
              credentialRevision: 0,
              updateId: UPDATE,
              password: "recovered",
            },
          );
          assert(reset.passwordChangeRequired);
          assertEquals(reset.credentialRevision, 1);
          const after = f.accounts.byId(ACCOUNT_A)!;
          assertEquals(after.totpKey, before.totpKey);
          assertEquals(after.totpKeyEncoding, before.totpKeyEncoding);
          assertEquals(
            Object.hasOwn(after, "totpKeyEncoding"),
            Object.hasOwn(before, "totpKeyEncoding"),
          );
          assertEquals(after.lastTotpStep, before.lastTotpStep);
          const reopened = new AccountRepository(f.root, undefined, {
            now: () => f.now,
          });
          await assertRejects(
            () => reopened.credentials.authenticate("alice", "recovered"),
            AuthenticationError,
          );
          await reopened.credentials.authenticate(
            "alice",
            "recovered",
            await f.code(),
          );
          // The original repository observes external publication through its bound
          // snapshot and must not overwrite the reopened owner's progress.
          await assertRejects(
            () =>
              f.accounts.credentials.disableAuthenticator(owner.authority, {
                accountId: ACCOUNT_A,
                credentialRevision: 1,
                updateId: NEXT_UPDATE,
              }),
            StoredConfigConflict,
            CONFLICT_MESSAGE,
          );
          const removed = await reopened.credentials.disableAuthenticator(
            owner.authority,
            {
              accountId: ACCOUNT_A,
              credentialRevision: 1,
              updateId: NEXT_UPDATE,
            },
          );
          assertEquals(removed.totpEnabled, false);
          assertEquals(removed.passwordChangeRequired, true);
          const final = new AccountRepository(f.root).byId(ACCOUNT_A)!;
          assertEquals(final.totpKey, null);
          assertEquals(final.lastTotpStep, null);
          assert(!Object.hasOwn(final, "totpKeyEncoding"));
          await reopened.credentials.authenticate("alice", "recovered");
        } finally {
          owner.close();
        }
      },
      {},
      { ...stored, floor: 100 },
    ));
}

for (
  const boundary of [
    "released owner",
    "lock replacement",
    "abort",
    "aggregate retirement",
  ] as const
) {
  fixtureTest(
    `offline recovery: ${boundary} during password hashing prevents reset`,
    (scope) => {
      const entered = fixtureGate(scope),
        release = fixtureGate<string>(scope);
      return credentialCommandFixture(async (f) => {
        const owner = recoveryForRoot(f.root), abort = new AbortController();
        const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
        const pending = f.accounts.credentials.resetPassword(owner.authority, {
          accountId: ACCOUNT_A,
          credentialRevision: 0,
          updateId: UPDATE,
          password: "recovered",
        }, abort.signal);
        pending.catch(() => {});
        try {
          await workMilestone(
            pending,
            entered.promise,
            "offline password hash entered",
          );
          if (boundary === "released owner") owner.close();
          if (boundary === "lock replacement") {
            Deno.writeTextFileSync(`${f.root}/replacement`, "");
            Deno.renameSync(`${f.root}/replacement`, `${f.root}/identity.lock`);
          }
          if (boundary === "abort") abort.abort();
          if (boundary === "aggregate retirement") {
            f.accounts.retireCredentials();
          }
          release.resolve(fixturePasswordHash("recovered"));
          await assertRejects(
            () => pending,
            AuthenticationError,
            AUTHENTICATION_MESSAGE,
          );
          assertEquals(
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            before,
          );
        } finally {
          release.resolve(fixturePasswordHash("recovered"));
          await pending.catch(() => {});
          owner.close();
        }
      }, {
        hash: () => {
          entered.resolve();
          return release.promise;
        },
      }, { key: "key", floor: 100 });
    },
  );
}

Deno.test("offline recovery: release at the staged write boundary prevents the actual reset effect", () =>
  preparationFixture(async (f) => {
    const account = await f.createInitial(),
      owner = f.offline(),
      write = Deno.writeTextFileSync;
    const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
    let staged = false;
    Deno.writeTextFileSync = (file, data, options) => {
      write(file, data, options);
      if (String(file).startsWith(`${f.root}/.config-`)) {
        staged = true;
        owner.close();
      }
    };
    try {
      await assertRejects(
        () =>
          f.accounts.credentials.resetPassword(owner.authority, {
            accountId: account.id,
            credentialRevision: 0,
            updateId: NEXT_UPDATE,
            password: "recovered",
          }),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      Deno.writeTextFileSync = write;
      owner.close();
    }
    assert(staged);
    assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
  }));

Deno.test("account preparation: initialized empty state cannot reopen initial account creation", () =>
  preparationFixture(async (f) => {
    const directory = `${f.root}/closed`;
    Deno.mkdirSync(directory);
    Deno.writeTextFileSync(
      `${directory}/accounts.json`,
      JSON.stringify({
        ...f.accounts.capture().value,
        initialized: true,
        revision: 1,
      }),
    );
    const closed = preparationContext(directory, {});
    try {
      await assertRejects(
        () =>
          closed.accounts.credentials.prepareInitialAccount(
            closed.authority("initial"),
            closed.request(),
          ),
        StoredConfigConflict,
      );
      assertEquals(closed.accounts.capture().value.accounts.length, 0);
    } finally {
      closed.retire();
      closed.accounts.retireCredentials();
    }
  }));

Deno.test("account preparation: recipient preparation cannot run on a fresh store or reuse a duplicate login", () =>
  preparationFixture(async (f) => {
    await assertRejects(
      () =>
        f.accounts.credentials.preparePasswordOnlyRecipient(
          f.authority("recipient"),
          f.request(),
        ),
      StoredConfigConflict,
    );
    await f.createInitial();
    await assertRejects(
      () =>
        f.accounts.credentials.preparePasswordOnlyRecipient(
          f.authority("recipient"),
          f.request({ login: " ALICE " }),
        ),
      StoredConfigConflict,
    );
    assertEquals(f.accounts.capture().value.accounts.length, 1);
  }));

fixtureTest(
  "account preparation: borrowed request changes cannot change the prepared login or publication receipt",
  (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate<string>(scope);
    return preparationFixture(async (f) => {
      const request = { ...f.request() };
      const pending = f.accounts.credentials.prepareInitialAccount(
        f.authority("initial"),
        request,
      );
      pending.catch(() => {});
      try {
        await workMilestone(
          pending,
          entered.promise,
          "initial preparation hash entered",
        );
        request.login = "bob";
        request.updateId = NEXT_UPDATE;
        request.password = "other password";
        release.resolve(fixturePasswordHash("password"));
        const prepared = await pending;
        f.accounts.credentials.publishPreparedAccount(prepared.prepared);
        assertEquals(prepared.identity.login, "alice");
        assertEquals(f.accounts.capture().value.updateId, UPDATE);
      } finally {
        release.resolve(fixturePasswordHash("password"));
        await pending.catch(() => {});
      }
    }, {
      hash: () => {
        entered.resolve();
        return release.promise;
      },
    });
  },
);

Deno.test("account preparation: published durability warning returns its exact account and never permits a retry", () =>
  preparationFixture(async (f) => {
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request(),
    );
    const open = Deno.openSync, link = Deno.linkSync, warning = logger.warning;
    let deny = false, warnings = 0;
    let observedIdentity:
      | ReturnType<typeof f.accounts.identityById>
      | undefined;
    Deno.linkSync = (from, to) => {
      link(from, to);
      if (String(to) === `${f.root}/accounts.json`) deny = true;
    };
    Deno.openSync = ((file, options) => {
      const handle = open(file, options);
      if (String(file) === f.root) {
        handle.syncSync = () => {
          if (deny) throw new Error("fixture directory sync");
        };
      }
      return handle;
    }) as typeof open;
    logger.warning = () => {
      deny = false;
      warnings++;
      observedIdentity = f.accounts.identityById(prepared.identity.id);
    };
    try {
      assertEquals(
        f.accounts.credentials.publishPreparedAccount(prepared.prepared),
        prepared.identity,
      );
      assertEquals(warnings, 1);
      assertEquals(observedIdentity, prepared.identity);
      assertThrows(
        () => f.accounts.credentials.publishPreparedAccount(prepared.prepared),
        IdentityStateError,
      );
    } finally {
      Deno.openSync = open;
      Deno.linkSync = link;
      logger.warning = warning;
    }
    assertEquals(
      new AccountRepository(f.root).identityById(prepared.identity.id),
      prepared.identity,
    );
  }));

Deno.test("offline recovery: reset revokes only the target's old sign-in and leaves another account unchanged", () =>
  preparationFixture(async (f) => {
    const alice = await f.createInitial();
    const pending = await f.accounts.credentials.preparePasswordOnlyRecipient(
      f.authority("recipient"),
      f.request({ login: "bob", updateId: NEXT_UPDATE }),
    );
    const bob = f.accounts.credentials.publishPreparedAccount(pending.prepared);
    const beforeBob = f.accounts.byId(bob.id);
    f.signing.initialize();
    const old = await signIn(f.sessions, {
        username: "alice",
        password: "password",
      }),
      other = await signIn(f.sessions, {
        username: "bob",
        password: "password",
      });
    const owner = f.offline();
    try {
      await f.accounts.credentials.resetPassword(owner.authority, {
        accountId: alice.id,
        credentialRevision: 0,
        updateId: UPDATE,
        password: "recovered",
      });
      await assertRejects(
        () => f.sessions.validateToken(old.access_token),
        AuthenticationError,
      );
      await f.sessions.validateToken(other.access_token);
      assertEquals(f.accounts.byId(bob.id), beforeBob);
      await signIn(f.sessions, { username: "alice", password: "recovered" });
    } finally {
      owner.close();
    }
  }));

Deno.test("account preparation: new password-only account reaches the prepared note consumer", () =>
  preparationFixture(async (f) => {
    await f.createInitial();
    f.signing.initialize();
    const token = await signIn(f.sessions, {
      username: "alice",
      password: "password",
    });
    const principal = await f.sessions.validateToken(token.access_token);
    const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
      accounts: f.accounts,
      declaredAdmin: "alice",
    });
    acl.prepareParents();
    const vault = {
      identity: {},
      id: VAULT_A,
      acl,
      lifecycle: { epoch: 0, operational: () => true },
    };
    const lifetime = createOperationLease("live", [() => undefined]);
    try {
      const authority = new InstanceAuthority(
          f.sessions,
          () => vault,
          lifetime.lease,
        ),
        lease = authority.lease(principal, "readVault");
      Deno.writeTextFileSync(
        `${f.root}/Note.md`,
        "Exact note bytes for the prepared account.\n",
      );
      const prepared = await lease.read(() =>
        Deno.readTextFile(`${f.root}/Note.md`)
      );
      const reader = lease.disclose(prepared).getReader();
      try {
        assertEquals(await reader.read(), {
          done: false,
          value: "Exact note bytes for the prepared account.\n",
        });
        assertEquals(await reader.read(), { done: true, value: undefined });
      } finally {
        reader.releaseLock();
      }
    } finally {
      lifetime.retire();
    }
  }));
