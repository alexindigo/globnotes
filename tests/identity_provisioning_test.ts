// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { createUuid } from "../shared/uuid.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { AclRepository } from "../server/auth/acl.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { VaultAccess } from "../server/auth/access.ts";
import { OwnAccount } from "../server/auth/account.ts";
import { AccountProvisioning } from "../server/auth/provisioning.ts";
import { IdentityTransactionUnavailable } from "../server/auth/transaction.ts";
import { AuthenticationError } from "../server/auth/sessions.ts";
import { bindAccountPreparationAuthority } from "../server/auth/internal/account_credentials.ts";
import {
  PublicationSetUnavailable,
  StoredConfigConflict,
} from "../server/config/publication_outcome.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { recoveryForRoot } from "./helpers/account_preparation.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { ownedContenders } from "./helpers/owned_contenders.ts";
import { VAULT_B } from "./helpers/identity.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import {
  identityWorkflowFixture,
  type IdentityWorkflows,
} from "./helpers/identity_workflows.ts";

const UNAVAILABLE =
  "Publication set is unavailable; settlement or recovery is required.";
const CONFLICT = "Stored configuration changed before commit.";
const CHANGED =
  "Access policy changed while this operation was pending; it was not applied.";
let interrupt = false;

async function request(f: IdentityWorkflows, changes = {}) {
  const view = await f.read(f.access.view(f.a));
  return {
    login: "recipient",
    temporaryPassword: "temporary",
    level: "edit",
    operationId: createUuid(),
    revision: view.revision,
    signature: view.signature,
    ...changes,
  };
}
const bytes = (f: IdentityWorkflows) => [
  Deno.readTextFileSync(`${f.root}/accounts.json`),
  Deno.readTextFileSync(`${f.root}/vault/access.json`),
];
/** The recipient's own I05 temporary-password completion, not a fixture write. */
async function completeTemporary(
  f: IdentityWorkflows,
  temporary: string,
  own: string,
) {
  const recipient = (await signIn(f.sessions, {
    username: "recipient",
    password: temporary,
  })).principal;
  assertEquals(recipient.passwordChangeRequired, true);
  const account = f.accounts.byLogin("recipient")!;
  return await f.read(
    new OwnAccount(f.authority).change(recipient, {
      revision: account.credentialRevision,
      updateId: createUuid(),
      currentPassword: temporary,
      newPassword: own,
    }),
  );
}

Deno.test("provisioning: a live Admin lease prepares the grant participant and its recipient pair", () =>
  identityWorkflowFixture(async (f) => {
    const admin = f.authority.lease(f.a, "manageVault");
    const operationId = createUuid();
    const prepare = async () =>
      await f.accounts.credentials.preparePasswordOnlyRecipient(
        bindAccountPreparationAuthority(
          f.accounts.credentials,
          "recipient",
          admin.lease,
        ),
        { login: "recipient", password: "temporary", updateId: operationId },
      );
    const accountsBefore = f.accounts.capture(), aclBefore = f.acl.capture();
    const before = bytes(f);
    const discarded = f.transaction.prepareRecipient(
      f.acl,
      await prepare(),
      "edit",
      aclBefore,
      { actorId: f.alice.id, payloadHash: "a".repeat(64) },
      admin.lease,
      operationId,
    );
    assertThrows(() => f.acl.capture(), PublicationSetUnavailable, UNAVAILABLE);
    assertThrows(
      () => f.accounts.capture(),
      PublicationSetUnavailable,
      UNAVAILABLE,
    );
    discarded.discard();
    assertStrictEquals(f.accounts.capture(), accountsBefore);
    assertStrictEquals(f.acl.capture(), aclBefore);
    assertEquals(
      [
        f.accounts.byLogin("recipient"),
        f.accounts.capture().value.provisioning,
      ],
      [null, []],
    );
    assertEquals(bytes(f), before);
    admin.assertCurrent(operationId);

    const prepared = await prepare();
    const parts = f.transaction.prepareRecipient(
      f.acl,
      prepared,
      "edit",
      f.acl.capture(),
      { actorId: f.alice.id, payloadHash: "b".repeat(64) },
      admin.lease,
      operationId,
    );
    f.transaction.commit(
      {
        kind: "create-and-add",
        operationId,
        actorId: f.alice.id,
        vaultId: f.vault.id,
      },
      parts,
      f.lease,
    );
    assertEquals(f.accounts.byLogin("recipient"), prepared.identity);
    assertEquals(f.acl.capture().value.grants, {
      [f.alice.id]: "admin",
      [prepared.identity.id]: "edit",
    });
    assertEquals(f.accounts.capture().value.provisioning, [{
      operationId,
      actorId: f.alice.id,
      vaultId: f.vault.id,
      accountId: prepared.identity.id,
      payloadHash: "b".repeat(64),
      committed: true,
      level: "edit",
      aclUpdateId: operationId,
    }]);
    // The grant itself changed this vault's policy: the old Admin lease ends.
    const error = assertThrows(
      () => admin.assertCurrent(operationId),
      OperationError,
      CHANGED,
    );
    assertEquals([error.status, error.code], [409, "operation_conflict"]);
  }));

Deno.test("provisioning: a foreign ACL repository cannot join this transaction", () =>
  identityWorkflowFixture(async (f) => {
    const admin = f.authority.lease(f.a, "manageVault");
    const operationId = createUuid();
    const prepared = await f.accounts.credentials.preparePasswordOnlyRecipient(
      bindAccountPreparationAuthority(
        f.accounts.credentials,
        "recipient",
        admin.lease,
      ),
      { login: "recipient", password: "temporary", updateId: operationId },
    );
    const foreign = new AclRepository(`${f.root}/vault`, f.vault.id, {
      accounts: f.accounts,
    });
    const before = bytes(f);
    assertThrows(
      () =>
        f.transaction.prepareRecipient(
          foreign,
          prepared,
          "edit",
          foreign.capture(),
          { actorId: f.alice.id, payloadHash: "a".repeat(64) },
          admin.lease,
          operationId,
        ),
      Error,
      "Invalid identity state; original bytes retained.",
    );
    assertEquals(bytes(f), before);
    assertEquals(f.acl.capture().value.grants, { [f.alice.id]: "admin" });
  }));

Deno.test("provisioning: both stores and receipt are durable; retry never resets a password or restores a removed grant", () =>
  identityWorkflowFixture(async (f) => {
    const input = await request(f);
    const result = await f.read(f.provisioning.createAndAdd(f.a, input));
    const account = f.accounts.byLogin("recipient")!;
    assertEquals(result, {
      operationId: input.operationId,
      accountId: account.id,
      committed: true,
    });
    assertEquals(
      [account.passwordChangeRequired, account.credentialRevision],
      [true, 0],
    );
    assertEquals(f.acl.capture().value.grants[account.id], "edit");
    const revision = f.accounts.capture().value.revision;
    assertEquals(await f.read(f.provisioning.createAndAdd(f.a, input)), result);
    assertEquals(f.accounts.capture().value.revision, revision);

    const restarted = await f.restart();
    assertEquals(
      (await completeTemporary(restarted, "temporary", "own-password"))
        .requiresLogin,
      true,
    );
    restarted.policy({ [restarted.alice.id]: "admin" });
    const settled = bytes(restarted);
    assertEquals(
      await restarted.read(
        restarted.provisioning.createAndAdd(restarted.a, input),
      ),
      result,
    );
    assertEquals(bytes(restarted), settled);
    assertEquals(
      restarted.acl.capture().value.grants,
      { [restarted.alice.id]: "admin" },
    );
    assertEquals(
      (await signIn(restarted.sessions, {
        username: "recipient",
        password: "own-password",
      })).principal.passwordChangeRequired,
      false,
    );
    assertEquals(restarted.accounts.byId(account.id)?.credentialRevision, 1);
    const receipts = restarted.accounts.capture().value.provisioning;
    assertEquals(receipts.length, 1);
    assertEquals(JSON.stringify(receipts).includes("temporary"), false);
    assertEquals(settled[0].includes("temporary"), false);
    assertEquals(
      await restarted.read(
        restarted.provisioning.review(restarted.a, input.operationId),
      ),
      result,
    );
  }));

for (const failure of ["demotion", "external", "cancel"] as const) {
  Deno.test(`provisioning: ${failure} during hashing publishes neither account nor access`, () => {
    let hold: (() => Promise<void>) | undefined;
    return identityWorkflowFixture(async (f) => {
      const input = await request(f);
      const controller = new AbortController();
      const accounts = Deno.readTextFileSync(`${f.root}/accounts.json`);
      await heldOperation({
        label: `recipient hashing ${failure}`,
        owner: () => f.provisioning,
        progress: { kind: "controlled", clock: "external" },
      }, (h) => {
        hold = h;
        return f.provisioning.createAndAdd(f.a, input, controller.signal);
      }, async (operation) => {
        await operation.reached();
        hold = undefined;
        if (failure === "demotion") f.policy({ [f.alice.id]: "view" });
        if (failure === "external") {
          const raw = Deno.readTextFileSync(`${f.root}/vault/access.json`);
          Deno.writeTextFileSync(`${f.root}/replacement`, raw);
          Deno.renameSync(
            `${f.root}/replacement`,
            `${f.root}/vault/access.json`,
          );
        }
        if (failure === "cancel") controller.abort();
        const acl = Deno.readTextFileSync(`${f.root}/vault/access.json`);
        if (failure === "cancel") {
          await assertRejects(
            () => operation.result(),
            DOMException,
            "The signal has been aborted",
          );
        } else {
          const error = await assertRejects(
            () => operation.result(),
            OperationError,
            CHANGED,
          );
          assertEquals(
            [error.status, error.code, error.operationId],
            [409, "operation_conflict", input.operationId],
          );
        }
        assertEquals(f.accounts.byLogin("recipient"), null);
        assertEquals(bytes(f), [accounts, acl]);
        f.transaction.assertReady();
      });
    }, { hashing: () => hold?.() });
  });
}

Deno.test("provisioning: interrupted publication hides both stores until restart recovery completes the pair", () =>
  identityWorkflowFixture(async (f) => {
    const input = await request(f);
    const before = bytes(f);
    interrupt = true;
    const error = await assertRejects(
      () => f.provisioning.createAndAdd(f.a, input),
      IdentityTransactionUnavailable,
      "Identity publication requires recovery; no partial state is available.",
    );
    assertEquals((error.cause as Error).message, "fixture interruption");
    interrupt = false;
    assertThrows(
      () => f.accounts.byLogin("recipient"),
      PublicationSetUnavailable,
      UNAVAILABLE,
    );
    assertThrows(
      () => f.acl.effectiveLevel(f.a),
      PublicationSetUnavailable,
      UNAVAILABLE,
    );
    assertEquals(bytes(f), before);
    const restarted = await f.restart();
    const recipient = restarted.accounts.byLogin("recipient")!;
    const result = {
      operationId: input.operationId,
      accountId: recipient.id,
      committed: true,
    };
    assertEquals(
      await restarted.read(
        restarted.provisioning.review(restarted.a, input.operationId),
      ),
      result,
    );
    assertEquals(
      await restarted.read(
        restarted.provisioning.createAndAdd(restarted.a, input),
      ),
      result,
    );
    assertEquals(restarted.acl.capture().value.grants[recipient.id], "edit");
    assertEquals(
      (await signIn(restarted.sessions, {
        username: "recipient",
        password: "temporary",
      })).principal.accountId,
      recipient.id,
    );
    assertEquals(
      restarted.accounts.capture().value.accounts.map((a) => a.login),
      ["alice", "bob", "recipient"],
    );
  }, {
    checkpoint: (phase) => {
      if (interrupt && phase === "decided") {
        throw new Error("fixture interruption");
      }
    },
  }));
Deno.test("provisioning: changed payload/initiator/target and existing login cannot be resumed", () =>
  identityWorkflowFixture(async (f) => {
    const input = await request(f);
    await f.read(f.provisioning.createAndAdd(f.a, input));
    const current = await f.read(f.access.view(f.a));
    for (
      const change of [
        { temporaryPassword: "different" },
        { level: "admin" },
        { login: "someone-else" },
      ]
    ) {
      await assertRejects(
        () =>
          f.provisioning.createAndAdd(f.a, {
            ...input,
            revision: current.revision,
            signature: current.signature,
            ...change,
          }),
        StoredConfigConflict,
        CONFLICT,
      );
    }
    f.policy({
      [f.alice.id]: "admin",
      [f.bob.id]: "admin",
      [f.accounts.byLogin("recipient")!.id]: "edit",
    });
    await assertRejects(
      () => f.provisioning.createAndAdd(f.b, input),
      StoredConfigConflict,
      CONFLICT,
    );
    await assertRejects(
      () =>
        f.provisioning.createAndAdd(f.a, {
          ...input,
          operationId: createUuid(),
        }),
      StoredConfigConflict,
      CONFLICT,
    );
    assertEquals(
      await f.read(f.provisioning.review(f.b, input.operationId)),
      { operationId: input.operationId, committed: false },
    );
    await assertRejects(
      () =>
        f.provisioning.createAndAdd(f.a, {
          ...input,
          login: "bob",
          operationId: createUuid(),
        }),
      StoredConfigConflict,
      CONFLICT,
    );
    assertEquals(f.accounts.byId(f.bob.id)?.credentialRevision, 0);
    assertEquals(f.accounts.capture().value.provisioning.length, 1);

    const acl = new AclRepository(`${f.root}/second-vault`, VAULT_B, {
      accounts: f.accounts,
    });
    acl.prepareParents();
    acl.initializeForCreator(f.alice, "none");
    const target = { ...f.vault, identity: {}, id: VAULT_B, acl };
    const access = new VaultAccess(
      new InstanceAuthority(f.sessions, () => target, f.lease),
      target,
    );
    const other = new AccountProvisioning(access, f.transaction);
    await assertRejects(
      () => other.createAndAdd(f.a, input),
      StoredConfigConflict,
      CONFLICT,
    );
    assertEquals(acl.capture().value.grants, { [f.alice.id]: "admin" });
  }));

for (const winner of ["primary", "contender"] as const) {
  for (const reversed of [false, true]) {
    Deno.test(`provisioning: ${winner} completes first (${reversed ? "reverse" : "forward"} submission) without duplicate commit or reset`, () => {
      const holds = new Map<string, () => Promise<void>>();
      return identityWorkflowFixture(async (f) => {
        const input = await request(f, { temporaryPassword: "primary" });
        const other = {
          ...input,
          temporaryPassword: "contender",
          operationId: createUuid(),
        };
        const before = f.accounts.capture().value;
        let observed: { bytes: string[]; result: unknown } | undefined;
        // The completing operation lets its recipient replace the temporary
        // password before the other admitted operation is released.
        const finish = async (password: string) => {
          if (observed) return;
          const result = await completeTemporary(f, password, "owned");
          observed = { bytes: bytes(f), result };
        };
        const primary = {
          owner: () => f.provisioning,
          progress: { kind: "product" } as const,
          start: async (hold: () => Promise<void>) => {
            holds.set("primary", hold);
            const first = f.provisioning.createAndAdd(f.a, input).then(f.read);
            const duplicate = f.provisioning.createAndAdd(f.a, { ...input })
              .then(f.read);
            const [a, b] = await Promise.allSettled([first, duplicate]);
            if (a.status === "fulfilled") await finish("primary");
            return { first: a, duplicate: b };
          },
        };
        const contender = {
          owner: () => f.provisioning,
          progress: { kind: "product" } as const,
          start: async (hold: () => Promise<void>) => {
            holds.set("contender", hold);
            const result = await f.read(
              f.provisioning.createAndAdd(f.a, other),
            );
            await finish("contender");
            return result;
          },
        };
        const outcomes = await ownedContenders(
          reversed ? { contender, primary } : { primary, contender },
          winner,
        );
        const winning = winner === "primary" ? input : other;
        const losing = winner === "primary" ? other : input;
        const account = f.accounts.byLogin("recipient")!;
        const receipt = {
          operationId: winning.operationId,
          accountId: account.id,
          committed: true,
        };
        assertEquals(outcomes.primary.status, "fulfilled");
        if (outcomes.primary.status !== "fulfilled") return;
        const { first, duplicate } = outcomes.primary.value;
        if (winner === "primary") {
          assertEquals([first, duplicate], [
            { status: "fulfilled", value: receipt },
            { status: "fulfilled", value: receipt },
          ]);
          assertEquals(outcomes.contender.status, "rejected");
          if (outcomes.contender.status !== "rejected") return;
          const error = outcomes.contender.reason as OperationError;
          assertEquals(
            [error.constructor, error.status, error.code, error.operationId],
            [OperationError, 409, "operation_conflict", losing.operationId],
          );
        } else {
          assertEquals(outcomes.contender, {
            status: "fulfilled",
            value: receipt,
          });
          assertEquals(first.status, "rejected");
          assertEquals(duplicate.status, "rejected");
          if (first.status !== "rejected" || duplicate.status !== "rejected") {
            return;
          }
          const error = first.reason as OperationError;
          assertEquals(
            [error.constructor, error.status, error.code, error.operationId],
            [OperationError, 409, "operation_conflict", losing.operationId],
          );
          assertEquals(
            [duplicate.reason.constructor, duplicate.reason.message],
            [StoredConfigConflict, CONFLICT],
          );
        }
        assertEquals(observed?.result, {
          account: {
            id: account.id,
            login: "recipient",
            totpEnabled: false,
            credentialRevision: 1,
            passwordChangeRequired: false,
            lastUpdateId: account.credentialUpdateId,
          },
          requiresLogin: true,
          updateId: account.credentialUpdateId,
        });
        const saved = f.accounts.capture().value;
        assertEquals(
          saved.accounts.map((a) => a.login),
          [...before.accounts.map((a) => a.login), "recipient"],
        );
        assertEquals(
          saved.provisioning.map((r) => [r.operationId, r.accountId, r.level]),
          [[winning.operationId, account.id, "edit"]],
        );
        assertEquals(account.credentialRevision, 1);
        assertEquals(f.acl.capture().value.grants, {
          [f.alice.id]: "admin",
          [account.id]: "edit",
        });
        assertEquals(bytes(f), observed?.bytes);

        const restarted = await f.restart();
        assertEquals(
          (await signIn(restarted.sessions, {
            username: "recipient",
            password: "owned",
          })).principal.accountId,
          account.id,
        );
        for (const password of ["primary", "contender"]) {
          await assertRejects(
            () =>
              signIn(restarted.sessions, { username: "recipient", password }),
            AuthenticationError,
            "Invalid authentication credentials.",
          );
        }
        assertEquals(
          await restarted.read(
            restarted.provisioning.review(restarted.a, winning.operationId),
          ),
          receipt,
        );
        assertEquals(
          await restarted.read(
            restarted.provisioning.review(restarted.a, losing.operationId),
          ),
          { operationId: losing.operationId, committed: false },
        );
      }, {
        // Only the two temporary passwords are held; "owned" is not.
        hashing: (password) => holds.get(password)?.(),
      });
    });
  }
}

for (
  const failure of ["preparation", "group discard", "set discard"] as const
) {
  Deno.test(`provisioning: recovery owns grant reservations after failed ${failure}`, () =>
    identityWorkflowFixture(async (f, scope) => {
      const input = await request(f), before = bytes(f);
      const acl = f.acl.capture();
      const vault = `${f.root}/vault`;
      let alias: string | undefined;
      const preparationFailure = new Error("Account preparation refused.");
      const replaceCandidate = () => {
        const names = [...Deno.readDirSync(vault)].map((entry) => entry.name);
        const [candidate] = names.filter((name) => name.startsWith(".config-"));
        alias = `${vault}/${candidate}`;
        Deno.renameSync(alias, `${vault}/held`);
        Deno.writeTextFileSync(alias, "foreign file");
      };
      let armed = false;
      const owner = createOperationLease("live", [() => {
        if (armed) {
          armed = false;
          replaceCandidate();
          throw preparationFailure;
        }
        return undefined;
      }]);
      scope.defer(() => owner.retire());
      const prepared = await f.accounts.credentials
        .preparePasswordOnlyRecipient(
          bindAccountPreparationAuthority(
            f.accounts.credentials,
            "recipient",
            owner.lease,
          ),
          {
            login: input.login,
            password: input.temporaryPassword,
            updateId: input.operationId,
          },
        );
      const stage = () =>
        f.transaction.prepareRecipient(
          f.acl,
          prepared,
          "edit",
          acl,
          { actorId: f.alice.id, payloadHash: "a".repeat(64) },
          f.lease,
          input.operationId,
        );
      const unavailable =
        "Identity publication requires recovery; no partial state is available.";
      try {
        if (failure === "preparation") {
          armed = true;
          const error = assertThrows(
            stage,
            AggregateError,
            "Identity participant preparation and cleanup failed.",
          );
          assertStrictEquals(error.cause, preparationFailure);
          assertEquals(error.errors.map((reason) => reason.message), [
            preparationFailure.message,
            CONFLICT,
          ]);
        } else {
          const group = stage();
          replaceCandidate();
          if (failure === "group discard") {
            const error = assertThrows(
              () => group.discard(),
              AggregateError,
              "Identity participant cleanup failed.",
            );
            assertEquals(error.errors.map((reason) => reason.message), [
              CONFLICT,
            ]);
          } else {
            assertThrows(
              () =>
                f.transaction.commit(
                  {
                    kind: "create-and-add",
                    operationId: input.operationId,
                    actorId: f.alice.id,
                    vaultId: f.vault.id,
                  },
                  group,
                  f.lease,
                ),
              IdentityTransactionUnavailable,
              unavailable,
            );
          }
        }
        assertEquals(Deno.readTextFileSync(alias!), "foreign file");
        assertEquals(bytes(f), before);
        assertThrows(
          () => Deno.statSync(`${f.root}/identity-transaction.json`),
          Deno.errors.NotFound,
          "No such file or directory",
        );
        assertThrows(
          f.transaction.assertReady,
          IdentityTransactionUnavailable,
          unavailable,
        );
        assertThrows(
          () => f.transaction.close(),
          IdentityTransactionUnavailable,
          unavailable,
        );
        assertThrows(
          () => f.acl.capture(),
          PublicationSetUnavailable,
          UNAVAILABLE,
        );
      } finally {
        if (alias) Deno.renameSync(`${vault}/held`, alias);
      }
      const recovery = recoveryForRoot(f.root);
      try {
        f.transaction.recover(recovery.authority);
      } finally {
        recovery.close();
      }
      assertThrows(
        () => Deno.statSync(alias!),
        Deno.errors.NotFound,
        "No such file or directory",
      );
      f.transaction.assertReady();
      assertEquals(
        [bytes(f), f.acl.capture(), f.accounts.byLogin(input.login)],
        [before, acl, null],
      );
      const committed = await f.read(f.provisioning.createAndAdd(f.a, input));
      assertEquals(committed, {
        operationId: input.operationId,
        accountId: f.accounts.byLogin(input.login)!.id,
        committed: true,
      });
    }));
}

Deno.test("provisioning validation rejects wrongly typed request fields with 422", () =>
  identityWorkflowFixture(async (f) => {
    const input = await request(f), before = bytes(f);
    for (
      const changes of [
        { login: ["recipient"] },
        { temporaryPassword: ["temporary"] },
        { level: ["edit"] },
        { operationId: [input.operationId] },
        { revision: [input.revision] },
        { signature: [input.signature] },
      ]
    ) {
      const error = await assertRejects(
        () => f.provisioning.createAndAdd(f.a, { ...input, ...changes }),
        HttpError,
        "HTTP 422",
      );
      assertEquals(error.status, 422, JSON.stringify(changes));
    }
    const review = await assertRejects(
      () => f.provisioning.review(f.a, [input.operationId]),
      HttpError,
      "HTTP 422",
    );
    assertEquals(review.status, 422);
    assertEquals(bytes(f), before);
  }));

Deno.test("provisioning disclosure: committed and absent receipts reject after an ACL edit", () =>
  identityWorkflowFixture(async (f) => {
    const input = await request(f);
    const created = await f.provisioning.createAndAdd(f.a, input);
    const retry = await f.provisioning.createAndAdd(f.a, input);
    const present = await f.provisioning.review(f.a, input.operationId);
    const absent = await f.provisioning.review(f.a, createUuid());
    f.policy({ [f.bob.id]: "admin" });
    for (const body of [created, retry, present, absent]) {
      await assertRejects(() => f.read(body), StoredConfigConflict, CONFLICT);
    }
    assertEquals(await f.read(f.provisioning.review(f.a, input.operationId)), {
      operationId: input.operationId,
      accountId: f.accounts.byLogin("recipient")!.id,
      committed: true,
    });
  }));

Deno.test("provisioning: each aborted waiter leaves the shared operation and its nonaborting waiters intact", () => {
  let hold: (() => Promise<void>) | undefined;
  return identityWorkflowFixture(async (f) => {
    const input = await request(f), before = bytes(f);
    await heldOperation({
      label: "shared recipient hashing",
      owner: () => f.provisioning,
      progress: { kind: "controlled", clock: "external" },
    }, (h) => {
      hold = h;
      return f.provisioning.createAndAdd(f.a, input).then(f.read);
    }, async (operation) => {
      await operation.reached();
      hold = undefined;
      const duplicate = new AbortController(), review = new AbortController();
      const duplicateDone = assertRejects(
        () =>
          bounded(
            f.provisioning.createAndAdd(f.a, input, duplicate.signal),
            "aborted duplicate",
          ),
        DOMException,
        "duplicate stopped",
      );
      const reviewDone = assertRejects(
        () =>
          bounded(
            f.provisioning.review(f.a, input.operationId, review.signal),
            "aborted review",
          ),
        DOMException,
        "review stopped",
      );
      duplicate.abort(new DOMException("duplicate stopped", "AbortError"));
      review.abort(new DOMException("review stopped", "AbortError"));
      await Promise.all([duplicateDone, reviewDone]);
      assertEquals(bytes(f), before);
      const remaining = f.provisioning.review(f.a, input.operationId).then(
        f.read,
      );
      const created = await operation.result();
      assertEquals(await remaining, created);
      assertEquals(created, {
        operationId: input.operationId,
        accountId: f.accounts.byLogin("recipient")!.id,
        committed: true,
      });
    });
  }, { hashing: () => hold?.() });
});

Deno.test("provisioning: outcome waits for admitted hash settlement, then remains actor-scoped after self-demotion", () => {
  let hold: (() => Promise<void>) | undefined;
  return identityWorkflowFixture(async (f) => {
    const input = await request(f);
    await heldOperation({
      label: "reviewed recipient hashing",
      owner: () => f.provisioning,
      progress: { kind: "controlled", clock: "external" },
    }, (h) => {
      hold = h;
      return f.provisioning.createAndAdd(f.a, input).then(f.read);
    }, async (operation) => {
      await operation.reached();
      hold = undefined;
      // Started while the receipt is absent; a premature read would be false.
      const reading = f.provisioning.review(f.a, input.operationId).then(
        f.read,
      );
      const created = await operation.result();
      assertEquals(await reading, created);
      assertEquals(created.committed, true);
    });
    f.policy({ [f.alice.id]: "view" });
    const before = bytes(f);
    const retry = await assertRejects(
      () => f.provisioning.createAndAdd(f.a, input),
      HttpError,
      "HTTP 403",
    );
    assertEquals(retry.status, 403);
    assertEquals(bytes(f), before);
    assertEquals(
      await f.read(f.provisioning.review(f.a, input.operationId)),
      {
        operationId: input.operationId,
        accountId: f.accounts.byLogin("recipient")!.id,
        committed: true,
      },
    );
    const denied = await assertRejects(
      () => f.access.view(f.a),
      Error,
      "HTTP 403",
    );
    assertEquals((denied as { status?: number }).status, 403);
    assertEquals(
      await f.read(f.provisioning.review(f.b, input.operationId)),
      { operationId: input.operationId, committed: false },
    );
  }, { hashing: () => hold?.() });
});

Deno.test("provisioning: only a negative receipt that joined the actor's admitted request proves settlement", () => {
  let hold: (() => Promise<void>) | undefined;
  return identityWorkflowFixture(async (f) => {
    const input = await request(f), before = bytes(f);
    const read = async (response: Response) => [
      response.status,
      await response.json(),
      response.headers.get("globnotes-creation-settled"),
    ];
    const absent = { operationId: input.operationId, committed: false };
    assertEquals(
      await read(await f.provisioning.reviewResponse(f.a, input.operationId)),
      [200, absent, null],
    );
    const refusal = new DOMException("creation stopped", "AbortError");
    const abort = new AbortController();
    await heldOperation({
      label: "recipient hash before refusal",
      owner: () => f.provisioning,
      progress: { kind: "controlled", clock: "external" },
    }, (h) => {
      hold = h;
      return assertRejects(
        () => f.provisioning.createAndAdd(f.a, input, abort.signal),
        DOMException,
        refusal.message,
      );
    }, async (operation) => {
      await operation.reached();
      hold = undefined;
      const own = f.provisioning.reviewResponse(f.a, input.operationId);
      const foreign = f.provisioning.reviewResponse(f.b, input.operationId);
      assertEquals(await bounded(foreign.then(read), "foreign receipt"), [
        200,
        absent,
        null,
      ]);
      abort.abort(refusal);
      await operation.result();
      assertEquals(await bounded(own.then(read), "own settled receipt"), [
        200,
        absent,
        "true",
      ]);
    });
    assertEquals(bytes(f), before);
  }, { hashing: () => hold?.() });
});
