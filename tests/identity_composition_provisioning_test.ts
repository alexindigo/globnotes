// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { VaultAccess } from "../server/auth/access.ts";
import { AccountProvisioning } from "../server/auth/provisioning.ts";
import { IdentityTransaction } from "../server/auth/transaction.ts";
import { readAuthorityState } from "../server/auth/authority_context.ts";
import { withIdentityComposition } from "./helpers/identity_scope.ts";

const OPERATION = "00000000-0000-4000-8000-000000000018";

Deno.test("identity composition: live Admin can publish an account and grant through instance service eligibility", () =>
  withIdentityComposition(async (f) => {
    f.policy("admin");
    const ordinaryReadiness: unknown[] = [];
    const transaction = new IdentityTransaction(f.accounts, f.acl, {
      vaultRoot: f.fixture.statePath,
      lease: f.lifetime.lease,
      checkpoint(phase) {
        if (phase !== "prepared") return;
        ordinaryReadiness.push([
          phase,
          readAuthorityState(f.composition.eligibility.operational),
          f.composition.lifecycle.operational(),
          f.composition.lifecycle.writable(),
        ]);
      },
    });
    const notifications: unknown[] = [];
    for (
      const [name, repository] of [
        ["accounts", f.accounts],
        ["access", f.acl],
      ] as const
    ) {
      f.scope.defer(repository.subscribe(() => {
        transaction.assertReady();
        const recipient = f.accounts.byLogin("recipient");
        notifications.push([
          name,
          recipient?.id,
          recipient ? f.acl.capture().value.grants[recipient.id] : null,
          f.accounts.capture().value.provisioning.map((receipt) =>
            receipt.operationId
          ),
          readAuthorityState(f.composition.eligibility.operational),
        ]);
      }));
    }
    const access = new VaultAccess(
      f.composition.authority,
      f.composition.vault,
    );
    const provisioning = new AccountProvisioning(access, transaction);
    const view = await new Response(await access.view(f.token.principal))
      .json();
    const result = await new Response(
      await provisioning.createAndAdd(
        f.token.principal,
        {
          login: "recipient",
          temporaryPassword: "temporary",
          level: "edit",
          operationId: OPERATION,
          revision: view.revision,
          signature: view.signature,
        },
      ),
    ).json();
    const recipient = f.accounts.byLogin("recipient");
    assertEquals(recipient?.login, "recipient");
    assertEquals(ordinaryReadiness, [["prepared", false, false, false]]);
    assertEquals([
      readAuthorityState(f.composition.eligibility.operational),
      f.composition.lifecycle.operational(),
      f.composition.lifecycle.writable(),
    ], [true, true, true]);
    assertEquals(result, {
      operationId: OPERATION,
      accountId: recipient!.id,
      committed: true,
    });
    assertEquals(f.acl.capture().value.grants, {
      [f.alice.id]: "admin",
      [recipient!.id]: "edit",
    });
    assertEquals(notifications, [
      ["access", recipient!.id, "edit", [OPERATION], true],
      ["accounts", recipient!.id, "edit", [OPERATION], true],
    ]);
    assertEquals(
      f.accounts.capture().value.provisioning.map((receipt) => ({
        operationId: receipt.operationId,
        accountId: receipt.accountId,
        committed: receipt.committed,
      })),
      [{ operationId: OPERATION, accountId: recipient!.id, committed: true }],
    );
  }));
