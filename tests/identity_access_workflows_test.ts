// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { createUuid } from "../shared/uuid.ts";
import { GUEST } from "../server/auth/sessions.ts";
import { StoredConfigConflict } from "../server/config/publication_outcome.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { VaultAccess } from "../server/auth/access.ts";
import { identityWorkflowFixture } from "./helpers/identity_workflows.ts";

const CONFLICT = "Stored configuration changed before commit.";

Deno.test("vault access: fresh projections retain admission and outcomes until real bundle replacement", () =>
  identityWorkflowFixture(async (f) => {
    let selected = { ...f.vault };
    const authority = new InstanceAuthority(
      f.sessions,
      () => ({ ...selected }),
      f.lease,
    );
    const access = new VaultAccess(authority, f.vault);
    const view = await f.read(access.view(f.a)), updateId = createUuid();
    assertEquals(await f.read(access.resolve(f.a, "bob")), {
      id: f.bob.id,
      login: "bob",
    });
    assertEquals(
      await f.read(access.update(f.a, {
        revision: view.revision,
        signature: view.signature,
        updateId,
        everybody: "none",
        grants: { [f.alice.id]: "admin", [f.bob.id]: "view" },
      })),
      {
        updateId,
        committed: true,
        capabilities: {
          canRead: true,
          canEdit: true,
          canManageVault: true,
          canManageOwnAccount: true,
          canCreateVault: true,
        },
      },
    );
    assertEquals(f.acl.effectiveLevel(f.b), "view");
    assertEquals((await f.read(access.outcome(f.a, updateId))).matched, true);
    selected = { ...selected, identity: {} };
    const error = await assertRejects(
      () => access.view(f.a),
      HttpError,
      "HTTP 404",
    );
    assertEquals(error.status, 404);
    const outcome = assertThrows(
      () => access.outcome(f.a, updateId),
      HttpError,
      "HTTP 422",
    );
    assertEquals(outcome.status, 422);
  }));

Deno.test("vault access: only Admin sees named labels and resolves an exact login", () =>
  identityWorkflowFixture(async (f) => {
    f.policy({ [f.alice.id]: "admin", [f.bob.id]: "view" });
    const view = await f.read(f.access.view(f.a));
    assertEquals(view.named, [
      { id: f.alice.id, login: "alice", level: "admin" },
      { id: f.bob.id, login: "bob", level: "view" },
    ]);
    assertEquals(Object.keys(view).sort(), [
      "declaredAdmin",
      "everybody",
      "grants",
      "named",
      "revision",
      "signature",
      "updateId",
      "vaultId",
    ]);
    assertEquals(await f.read(f.access.resolve(f.a, " BOB ")), {
      id: f.bob.id,
      login: "bob",
    });
    assertEquals(await f.read(f.access.resolve(f.a, "bo")), null);
    assertEquals(await f.read(f.access.resolve(f.a, "")), null);
    const denied = await assertRejects(
      () => f.access.view(f.b),
      HttpError,
      "HTTP 403",
    );
    assertEquals(denied.status, 403);
    const guest = assertThrows(
      () => f.access.resolve(GUEST, "bob"),
      HttpError,
      "HTTP 403",
    );
    assertEquals(guest.status, 403);
  }));

Deno.test("vault access: revision/signature CAS, exact-login addition and no guest Admin", () =>
  identityWorkflowFixture(async (f) => {
    const view = await f.read(f.access.view(f.a)), updateId = createUuid();
    const input = {
      revision: view.revision,
      signature: view.signature,
      updateId,
      everybody: "edit",
      grants: { [f.alice.id]: "admin" },
      additions: [{ login: "bob", level: "none" }],
    };
    const invalid = await assertRejects(
      () => f.access.update(f.a, { ...input, everybody: "admin" }),
      HttpError,
      "HTTP 422",
    );
    assertEquals(invalid.status, 422);
    const missing = await assertRejects(
      () =>
        f.access.update(f.a, {
          ...input,
          additions: [{ login: "nobody", level: "view" }],
        }),
      HttpError,
      "HTTP 409",
    );
    assertEquals(missing.status, 409);
    assertEquals((await f.read(f.access.update(f.a, input))).committed, true);
    assertEquals(f.acl.effectiveLevel(f.b), "none");
    assertEquals(f.acl.effectiveLevel(GUEST), "edit");
    await assertRejects(
      () => f.access.update(f.a, input),
      StoredConfigConflict,
      CONFLICT,
    );
    assertEquals(
      [f.acl.capture().value.updateId, f.acl.capture().value.updateActorId],
      [updateId, f.alice.id],
    );
  }));

Deno.test("vault access: self-demotion acknowledgment and actor-bound lost-reply status reveal no full ACL", () =>
  identityWorkflowFixture(async (f) => {
    const view = await f.read(f.access.view(f.a)), updateId = createUuid();
    const result = await f.read(f.access.update(f.a, {
      revision: view.revision,
      signature: view.signature,
      updateId,
      everybody: "none",
      grants: { [f.alice.id]: "none", [f.bob.id]: "admin" },
    }));
    assertEquals(result, {
      updateId,
      committed: true,
      capabilities: {
        canRead: false,
        canEdit: false,
        canManageVault: false,
        canManageOwnAccount: true,
        canCreateVault: true,
      },
    });
    const own = await f.read(f.access.outcome(f.a, updateId));
    assertEquals(own, { matched: true, capabilities: result.capabilities });
    assertEquals(
      (await f.read(f.access.outcome(f.b, updateId))).matched,
      false,
    );
    const denied = await assertRejects(
      () => f.access.view(f.a),
      HttpError,
      "HTTP 403",
    );
    assertEquals(denied.status, 403);
    const next = await f.read(f.access.view(f.b));
    await f.read(f.access.update(f.b, {
      revision: next.revision,
      signature: next.signature,
      updateId: createUuid(),
      everybody: "view",
      grants: {},
    }));
    assertEquals(
      (await f.read(f.access.outcome(f.a, updateId))).matched,
      false,
    );
  }));

for (const cause of ["external", "cancel"] as const) {
  Deno.test(`vault access: ${cause} at commit retains bytes and memory`, () =>
    identityWorkflowFixture(async (f) => {
      const view = await f.read(f.access.view(f.a));
      const before = f.acl.capture();
      const controller = new AbortController();
      if (cause === "external") {
        const raw = Deno.readTextFileSync(`${f.root}/vault/access.json`);
        Deno.writeTextFileSync(`${f.root}/replacement`, raw);
        Deno.renameSync(`${f.root}/replacement`, `${f.root}/vault/access.json`);
      }
      if (cause === "cancel") controller.abort();
      const expected = Deno.readTextFileSync(`${f.root}/vault/access.json`);
      if (cause === "external") {
        const error = await assertRejects(
          () =>
            f.access.update(f.a, {
              revision: view.revision,
              signature: view.signature,
              updateId: createUuid(),
              everybody: "edit",
              grants: {},
            }, controller.signal),
          OperationError,
          "Access policy changed while this operation was pending; it was not applied.",
        );
        assertEquals([error.status, error.code], [409, "operation_conflict"]);
      } else {
        await assertRejects(
          () =>
            f.access.update(f.a, {
              revision: view.revision,
              signature: view.signature,
              updateId: createUuid(),
              everybody: "edit",
              grants: {},
            }, controller.signal),
          DOMException,
          "The signal has been aborted",
        );
      }
      assertEquals(f.acl.capture().value, before.value);
      assertEquals(
        Deno.readTextFileSync(`${f.root}/vault/access.json`),
        expected,
      );
    }));
}
