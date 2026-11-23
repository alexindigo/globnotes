// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createUuid } from "../shared/uuid.ts";
import { AccessLoginConflict } from "../server/auth/access_login_conflict.ts";
import { StoredConfigConflict } from "../server/config/publication_outcome.ts";
import {
  identityWorkflowFixture,
  type IdentityWorkflows,
} from "./helpers/identity_workflows.ts";

let refuse = false;
async function request(f: IdentityWorkflows) {
  const view = await f.read(f.access.view(f.a));
  return {
    login: "recipient",
    temporaryPassword: "temporary",
    level: "edit",
    operationId: createUuid(),
    revision: view.revision,
    signature: view.signature,
  };
}

Deno.test("atomic provisioning: a duplicate login differs from stale access without publishing either", () =>
  identityWorkflowFixture(async (f) => {
    const before = [f.accounts.capture().value, f.acl.capture().value];
    const input = { ...await request(f), login: "bob" };
    const refusal = await assertRejects(
      () => f.provisioning.createAndAdd(f.a, input),
      AccessLoginConflict,
      "HTTP 409",
    );
    assertEquals(await refusal.response().json(), {
      code: "access_login_conflict",
      detail: "The login could not be added to this vault.",
    });
    await assertRejects(
      () => f.provisioning.createAndAdd(f.a, { ...input, signature: "stale" }),
      StoredConfigConflict,
      "Stored configuration changed before commit.",
    );
    assertEquals([f.accounts.capture().value, f.acl.capture().value], before);
  }));

Deno.test("atomic provisioning: a refused prepared decision leaves neither account nor grant", () =>
  identityWorkflowFixture(async (f) => {
    const input = await request(f);
    const before = [
      Deno.readTextFileSync(`${f.root}/accounts.json`),
      Deno.readTextFileSync(`${f.root}/vault/access.json`),
    ];
    const accounts = f.accounts.capture(), acl = f.acl.capture();
    refuse = true;
    try {
      await assertRejects(
        () => f.provisioning.createAndAdd(f.a, input),
        Error,
        "fixture refusal before decision",
      );
    } finally {
      refuse = false;
    }
    assertEquals(f.accounts.byLogin("recipient"), null);
    assertEquals(
      [f.accounts.capture().value, f.acl.capture().value],
      [accounts.value, acl.value],
    );
    assertEquals([
      Deno.readTextFileSync(`${f.root}/accounts.json`),
      Deno.readTextFileSync(`${f.root}/vault/access.json`),
    ], before);
    f.transaction.assertReady();
    // Nothing partial remains: the same operation can still complete once.
    const result = await f.read(f.provisioning.createAndAdd(f.a, input));
    assertEquals(result, {
      operationId: input.operationId,
      accountId: f.accounts.byLogin("recipient")!.id,
      committed: true,
    });
  }, {
    checkpoint: (phase) => {
      if (refuse && phase === "prepared") {
        throw new Error("fixture refusal before decision");
      }
    },
  }));

Deno.test("atomic provisioning: success acknowledges both effects and one receipt, not a partial result", () =>
  identityWorkflowFixture(async (f) => {
    const input = await request(f);
    const result = await f.read(f.provisioning.createAndAdd(f.a, input));
    const account = f.accounts.byLogin("recipient")!;
    assertEquals(result, {
      operationId: input.operationId,
      accountId: account.id,
      committed: true,
    });
    assertEquals(f.acl.capture().value.grants, {
      [f.alice.id]: "admin",
      [account.id]: "edit",
    });
    assertEquals(
      [f.acl.capture().value.updateId, f.acl.capture().value.updateActorId],
      [input.operationId, f.alice.id],
    );
    const [receipt] = f.accounts.capture().value.provisioning;
    assertEquals(f.accounts.capture().value.provisioning.length, 1);
    assertEquals({ ...receipt, payloadHash: "" }, {
      operationId: input.operationId,
      actorId: f.alice.id,
      vaultId: f.vault.id,
      accountId: account.id,
      payloadHash: "",
      committed: true,
      level: "edit",
      aclUpdateId: input.operationId,
    });
    assertEquals(/^[0-9a-f]{64}$/.test(receipt.payloadHash), true);
  }));
