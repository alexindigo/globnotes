// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { identityFixture, UPDATE, VAULT_A } from "./helpers/identity.ts";
import {
  identityRecoveryLease,
  transactionContext,
} from "./helpers/identity_transaction.ts";
import {
  type IdentityParticipants,
  IdentityTransactionUnavailable,
} from "../server/auth/transaction.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { PublicationSetUnavailable } from "../server/config/publication_outcome.ts";
import { recoveryForRoot } from "./helpers/account_preparation.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { spawnOwnedChild } from "./helpers/owned_child.ts";
import { DENO } from "./helpers/process_values.ts";
import { fromFileUrl } from "@std/path";
import {
  objectRecordSchema,
  openRecordDirectory,
  recordReader,
} from "./helpers/owned_record_channel.ts";

const unavailable =
  "Identity publication requires recovery; no partial state is available.";
const setUnavailable =
  "Publication set is unavailable; settlement or recovery is required.";
const schema = objectRecordSchema("identity transaction", (value) => value);

for (
  const change of [
    "clone",
    "foreign-owner",
    "operation",
    "actor",
    "kind",
    "vault",
  ] as const
) {
  Deno.test(`identity transaction: ${change} cannot consume or discard another registered preparation`, () =>
    identityFixture(async (root, scope) => {
      const f = transactionContext(root, scope), staged = await f.stage();
      const before = [...Deno.readDirSync(root)].map((e) => e.name).sort();
      const target = change === "foreign-owner"
        ? transactionContext(`${root}/other`, scope)
        : f;
      const group = change === "clone"
        ? { ...staged.parts } as IdentityParticipants
        : staged.parts;
      const meta = {
        ...staged.meta,
        ...(change === "operation"
          ? { operationId: VAULT_A }
          : change === "actor"
          ? { actorId: UPDATE }
          : change === "kind"
          ? { kind: "create-and-add" as const }
          : change === "vault"
          ? { vaultId: UPDATE }
          : {}),
      };
      assertThrows(
        () => target.transaction.commit(meta, group, target.lease),
        IdentityStateError,
        "Invalid identity state; original bytes retained.",
      );
      assertEquals(
        [...Deno.readDirSync(root)].map((e) => e.name).sort(),
        before,
      );
      assertEquals(
        f.transaction.commit(staged.meta, staged.parts, f.lease).state,
        "committed",
      );
      assertEquals(f.accounts.byLogin("alice"), staged.identity);
      const accountBytes = Deno.readTextFileSync(`${root}/accounts.json`),
        accessBytes = Deno.readTextFileSync(`${root}/vault/access.json`);
      assertThrows(
        () => f.transaction.commit(staged.meta, staged.parts, f.lease),
        IdentityStateError,
        "Invalid identity state; original bytes retained.",
      );
      assertEquals([
        Deno.readTextFileSync(`${root}/accounts.json`),
        Deno.readTextFileSync(`${root}/vault/access.json`),
      ], [accountBytes, accessBytes]);
    }));
}

Deno.test("identity transaction: aliases share the root owner until it closes", () =>
  identityFixture((root, scope) => {
    const directory = `${root}/physical`;
    const alias = `${root}/alias`;
    Deno.mkdirSync(directory);
    Deno.symlinkSync(directory, alias);
    const first = transactionContext(directory, scope).transaction;
    first.assertReady();
    assertThrows(
      () => transactionContext(alias, scope),
      IdentityTransactionUnavailable,
      unavailable,
    );
    first.close();
    assertThrows(
      first.assertReady,
      IdentityTransactionUnavailable,
      unavailable,
    );
    const next = transactionContext(alias, scope).transaction;
    next.assertReady();
    first.close();
    assertThrows(
      () => transactionContext(directory, scope),
      IdentityTransactionUnavailable,
      unavailable,
    );
  }));

Deno.test("identity transaction: an issued recovery lease cannot stage or consume a setup group", () =>
  identityFixture(async (root, scope) => {
    const f = transactionContext(root, scope);
    const stage = await f.prepareStage();
    const lease = identityRecoveryLease(scope) as unknown as typeof f.lease;
    const modeError = "Sink requires an issued operation lease of its mode";
    assertThrows(() => stage(lease), TypeError, modeError);
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), ["vault"]);
    assertEquals([...Deno.readDirSync(`${root}/vault`)], []);
    const staged = stage();
    assertThrows(
      () => f.transaction.commit(staged.meta, staged.parts, lease),
      TypeError,
      modeError,
    );
    f.transaction.assertReady();
    assertEquals(
      f.transaction.commit(staged.meta, staged.parts, f.lease).state,
      "committed",
    );
  }));

Deno.test("identity transaction: exact account/marker and creator ACL settle before admission", () =>
  identityFixture(async (root, scope) => {
    const events: unknown[] = [];
    const f = transactionContext(root, scope, (phase) => {
      events.push(phase);
      if (phase === "journal-unlinked") {
        assertThrows(
          () => Deno.statSync(`${root}/identity-transaction.json`),
          Deno.errors.NotFound,
        );
      }
      assertThrows(
        () => f.transaction.assertReady(),
        IdentityTransactionUnavailable,
        unavailable,
      );
      assertThrows(
        () => f.accounts.capture(),
        PublicationSetUnavailable,
        setUnavailable,
      );
      assertThrows(
        () => f.acl.capture(),
        PublicationSetUnavailable,
        setUnavailable,
      );
    });
    const staged = await f.stage();
    const result = f.transaction.commit(staged.meta, staged.parts, f.lease);
    assertEquals(result.state, "committed");
    assertEquals(events, [
      "prepared",
      "decision-attempt",
      "decided",
      "installed",
      "retiring",
      "journal-unlinked",
    ]);
    f.transaction.assertReady();
    assertEquals(f.accounts.capture().value, {
      version: 1,
      revision: 1,
      initialized: true,
      updateId: UPDATE,
      accounts: [staged.identity],
      provisioning: [],
    });
    assertEquals(f.acl.capture().value, {
      version: 1,
      vaultId: VAULT_A,
      revision: 1,
      updateId: f.acl.capture().value.updateId,
      updateActorId: staged.identity.id,
      everybody: "view",
      grants: { [staged.identity.id]: "admin" },
    });
    assertEquals(
      Deno.readTextFileSync(`${root}/vault/access.json`),
      JSON.stringify(f.acl.capture().value) + "\n",
    );
    f.signing.initialize();
    const session = await signIn(f.sessions, {
      username: "alice",
      password: "password",
    });
    assertEquals(
      (await f.sessions.validateToken(session.access_token)).accountId,
      staged.identity.id,
    );
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name).sort(), [
      "accounts.json",
      "sessions.json",
      "vault",
    ]);
  }));

Deno.test("identity transaction: prepared rejection discards both without publication", () =>
  identityFixture(async (root, scope) => {
    const error = new Error("fixture before decision");
    const f = transactionContext(root, scope, (phase) => {
      if (phase === "prepared") throw error;
    });
    const staged = await f.stage();
    assertStrictEquals(
      assertThrows(
        () => f.transaction.commit(staged.meta, staged.parts, f.lease),
        Error,
        error.message,
      ),
      error,
    );
    assertStrictEquals(f.accounts.capture(), staged.before);
    assertEquals(f.acl.capture().persistence.raw, null);
    f.transaction.assertReady();
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), ["vault"]);
    assertEquals([...Deno.readDirSync(`${root}/vault`)], []);
  }));

for (
  const phase of [
    "decision-attempt",
    "cleanup-access",
    "cleanup-accounts",
    "cleanup-journal",
    "decided",
    "half",
    "installed",
    "retiring",
  ] as const
) {
  Deno.test(`identity transaction: ${phase} process loss recovers the recorded pair`, () =>
    identityFixture(async (root, scope) => {
      const child = (await spawnOwnedChild(scope, DENO, {
        args: [
          "run",
          "--allow-all",
          fromFileUrl(
            new URL("./helpers/identity_transaction_child.ts", import.meta.url),
          ),
          root,
          phase,
        ],
        stdout: "null",
        stderr: "piped",
      })).value;
      const stderr = new Response(child.stderr).text();
      const status = await child.exited;
      assertEquals([status.success, status.code, status.signal], [
        false,
        1,
        null,
      ]);
      // Inspect the actual terminal error, not process death as a cleanup claim.
      const error = await stderr;
      assertEquals(error.includes("IdentityTransactionUnavailable"), true);
      if (phase === "half") {
        assertEquals(
          error.split("\n")[0],
          "identity crash: first participant published",
        );
        assertEquals(Deno.statSync(`${root}/vault/access.json`).isFile, true);
        assertThrows(
          () => Deno.statSync(`${root}/accounts.json`),
          Deno.errors.NotFound,
          `${root}/accounts.json`,
        );
      }
      const undecided = phase === "decision-attempt" ||
        phase.startsWith("cleanup-");
      const saved = recordReader(
        openRecordDirectory(scope, root),
        "identity-transaction.json",
        schema,
      ).read()!.value;
      assertEquals(
        [saved.kind, saved.operationId, saved.vaultId, saved.phase],
        [
          "setup",
          UPDATE,
          VAULT_A,
          undecided ? "prepared" : "decided",
        ],
      );
      const names = (directory: string) =>
        [...Deno.readDirSync(directory)].map((entry) => entry.name).sort();
      if (undecided) {
        assertEquals(error.includes(`identity crash: ${phase}`), true);
        const [access, accounts] =
          (saved.participants as { candidate: string }[])
            .map((participant) => participant.candidate);
        assertEquals(names(root), [
          ...(phase === "decision-attempt" || phase === "cleanup-accounts"
            ? [accounts]
            : []),
          "identity-transaction.json",
          "vault",
        ]);
        assertEquals(
          names(`${root}/vault`),
          phase === "decision-attempt" || phase === "cleanup-access"
            ? [access]
            : [],
        );
      }
      const recovery = recoveryForRoot(root);
      scope.defer(() => recovery.close());
      const f = transactionContext(root, scope);
      assertThrows(
        () => f.transaction.assertReady(),
        IdentityTransactionUnavailable,
        unavailable,
      );
      f.transaction.recover(recovery.authority);
      f.transaction.assertReady();
      assertEquals(
        [
          f.accounts.initialized,
          f.accounts.capture().value.accounts.map((a) => a.login),
          f.acl.capture().value.everybody,
        ],
        undecided ? [false, [], "none"] : [true, ["alice"], "view"],
      );
      f.signing.initialize();
      if (undecided) {
        await assertRejects(
          () => signIn(f.sessions, { username: "alice", password: "password" }),
          Error,
          "Invalid authentication credentials.",
        );
      } else {
        const session = await signIn(f.sessions, {
          username: "alice",
          password: "password",
        });
        assertEquals([
          f.acl.effectiveLevel(session.principal),
          f.acl.effectiveLevel({ kind: "guest" }),
        ], ["admin", "view"]);
      }
      f.transaction.recover(recovery.authority);
      assertEquals(
        [...Deno.readDirSync(root)].map((e) => e.name).sort(),
        undecided
          ? ["identity.lock", "sessions.json", "vault"]
          : ["accounts.json", "identity.lock", "sessions.json", "vault"],
      );
      if (undecided) assertEquals(names(`${root}/vault`), []);
    }));
}

Deno.test("identity transaction: forged recovery authority refuses even an absent journal", () =>
  identityFixture((root, scope) => {
    const f = transactionContext(root, scope);
    assertThrows(
      () => f.transaction.recover({} as never),
      IdentityStateError,
      "Invalid identity state; original bytes retained.",
    );
    f.transaction.assertReady();
  }));

for (
  const change of ["role", "root", "set", "vault", "foreign-access"] as const
) {
  Deno.test(`identity transaction: ${change} recovery conflict preserves exact evidence`, () =>
    identityFixture(async (root, scope) => {
      const f = transactionContext(root, scope, (point) => {
        if (point === "installed") {
          throw new Error("fixture installed interruption");
        }
      });
      const staged = await f.stage();
      assertThrows(
        () => f.transaction.commit(staged.meta, staged.parts, f.lease),
        IdentityTransactionUnavailable,
        unavailable,
      );
      const journal = `${root}/identity-transaction.json`;
      const accountBytes = Deno.readTextFileSync(`${root}/accounts.json`);
      const accessBytes = Deno.readTextFileSync(`${root}/vault/access.json`);
      const value = JSON.parse(Deno.readTextFileSync(journal));
      if (change === "role") value.participants[0].role = "other";
      if (change === "root") value.participants[0].root = `${root}/foreign`;
      if (change === "set") value.participants[0].setId = VAULT_A;
      if (change === "vault") value.vaultId = UPDATE;
      if (change === "foreign-access") {
        Deno.writeTextFileSync(`${root}/replacement`, accessBytes);
        Deno.renameSync(`${root}/replacement`, `${root}/vault/access.json`);
      } else Deno.writeTextFileSync(journal, JSON.stringify(value) + "\n");
      const journalBytes = Deno.readTextFileSync(journal);
      const accessInode = Deno.statSync(`${root}/vault/access.json`).ino;
      const recovery = recoveryForRoot(root);
      scope.defer(() => recovery.close());
      f.retire();
      const next = transactionContext(root, scope);
      assertThrows(
        () => next.transaction.recover(recovery.authority),
        IdentityTransactionUnavailable,
        unavailable,
      );
      assertThrows(
        () => next.transaction.assertReady(),
        IdentityTransactionUnavailable,
        unavailable,
      );
      assertEquals([
        Deno.readTextFileSync(`${root}/accounts.json`),
        Deno.readTextFileSync(`${root}/vault/access.json`),
        Deno.readTextFileSync(journal),
        Deno.statSync(`${root}/vault/access.json`).ino,
      ], [accountBytes, accessBytes, journalBytes, accessInode]);
    }));
}
