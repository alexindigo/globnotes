// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { createUuid } from "../shared/uuid.ts";
import { GUEST } from "../server/auth/sessions.ts";
import { StoredConfigConflict } from "../server/config/publication_outcome.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import {
  identityAuthCheck,
  VaultAccess,
  vaultAccessHandlers,
} from "../server/auth/access.ts";
import { IdentityStateError } from "../server/auth/records.ts";
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
    const duplicate = await assertRejects(
      () =>
        f.access.update(f.a, {
          ...input,
          additions: [...input.additions, { login: " BOB ", level: "view" }],
        }),
      HttpError,
      "HTTP 409",
    );
    assertEquals(duplicate.status, 409);
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

Deno.test("vault access: exact-login conflicts have the same safe HTTP response and do not replace the CAS", () =>
  identityWorkflowFixture(async (f) => {
    const before = await f.read(f.access.view(f.a));
    const handlers = vaultAccessHandlers(f.access, () => Promise.resolve(f.a));
    const put = (login: string, signature = before.signature) => {
      return handlers.put(
        new Request("http://fixture/_/api/access", {
          method: "PUT",
          body: JSON.stringify({
            revision: before.revision,
            signature,
            updateId: createUuid(),
            everybody: before.everybody,
            grants: before.grants,
            additions: [{ login, level: "view" }],
          }),
        }),
      );
    };
    for (const login of ["nobody", "alice"]) {
      const response = await put(login);
      assertEquals([response.status, await response.json()], [409, {
        code: "access_login_conflict",
        detail: "The login could not be added to this vault.",
      }]);
    }
    await assertRejects(
      () => put("alice", "stale"),
      StoredConfigConflict,
      CONFLICT,
    );
    assertEquals(await f.read(f.access.view(f.a)), before);
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
    const check = (principal: typeof f.a) =>
      identityAuthCheck(
        new Request(
          `http://fixture/_/api/auth-check?accessUpdateId=${updateId}`,
        ),
        f.access,
        () => Promise.resolve(principal),
        () => Response.json("ordinary status"),
      );
    const own = await check(f.a), foreign = await check(f.b);
    assertEquals([own.status, await own.json()], [200, {
      matched: true,
      capabilities: result.capabilities,
    }]);
    assertEquals([foreign.status, await foreign.json()], [200, {
      matched: false,
      capabilities: f.access.authority.capabilities(f.b, f.vault),
    }]);
    const status = await identityAuthCheck(
      new Request("http://fixture/_/api/auth-check"),
      f.access,
      () => Promise.reject(Error("ordinary status does not need the receipt")),
      () => Response.json("ordinary status"),
    );
    assertEquals(await status.json(), "ordinary status");
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

Deno.test("vault access validation rejects wrongly typed request fields with 422", () =>
  identityWorkflowFixture(async (f) => {
    const view = await f.read(f.access.view(f.a));
    const input = {
      revision: view.revision,
      signature: view.signature,
      updateId: createUuid(),
      everybody: "edit",
      grants: { [f.alice.id]: "admin" },
    };
    const trailingHole = [{ login: "bob", level: "view" }];
    trailingHole.length = 2;
    for (
      const changes of [
        { everybody: { toString: null, valueOf: null } },
        { everybody: ["edit"] },
        { revision: [view.revision] },
        { signature: [view.signature] },
        { updateId: [input.updateId] },
        { grants: [] },
        { grants: { [f.alice.id]: ["admin"] } },
        { additions: null },
        { additions: new Array(1) },
        { additions: trailingHole },
        { additions: [{ login: ["bob"], level: "view" }] },
        { additions: [{ login: "bob", level: ["view"] }] },
      ]
    ) {
      const error = await assertRejects(
        () => f.access.update(f.a, { ...input, ...changes }),
        HttpError,
        "HTTP 422",
      );
      assertEquals(error.status, 422, JSON.stringify(changes));
    }
    assertEquals(await f.read(f.access.view(f.a)), view);
    const resolve = assertThrows(
      () => f.access.resolve(f.a, ["bob"]),
      HttpError,
      "HTTP 422",
    );
    const outcome = assertThrows(
      () => f.access.outcome(f.a, [input.updateId]),
      HttpError,
      "HTTP 422",
    );
    assertEquals([resolve.status, outcome.status], [422, 422]);
  }));

for (const action of ["resolve", "update"] as const) {
  Deno.test(`vault access: ${action} propagates account directory validation errors`, () =>
    identityWorkflowFixture(async (f) => {
      const view = await f.read(f.access.view(f.a));
      const before = f.acl.capture();
      const failure = new IdentityStateError();
      // Fail the public lookup without short-circuiting live Admin admission.
      f.accounts.byLogin = () => {
        throw failure;
      };
      const error = await assertRejects(
        async () => {
          if (action === "resolve") {
            return await f.read(f.access.resolve(f.a, "bob"));
          }
          return await f.read(f.access.update(f.a, {
            revision: view.revision,
            signature: view.signature,
            updateId: createUuid(),
            everybody: "none",
            grants: { [f.alice.id]: "admin" },
            additions: [{ login: "bob", level: "view" }],
          }));
        },
        IdentityStateError,
        failure.message,
      );
      assertStrictEquals(error, failure);
      assertStrictEquals(f.acl.capture(), before);
    }));
}

for (const response of ["view", "resolve", "update", "outcome"] as const) {
  Deno.test(`vault access disclosure: ${response} rejects when the vault stops before pull`, () =>
    identityWorkflowFixture(async (f) => {
      let operational = true;
      const vault = {
        ...f.vault,
        lifecycle: { epoch: 0, operational: () => operational },
      };
      const access = new VaultAccess(
        new InstanceAuthority(f.sessions, () => vault, f.lease),
        vault,
      );
      const view = await f.read(access.view(f.a));
      const updateId = createUuid();
      const body = await (response === "view"
        ? access.view(f.a)
        : response === "resolve"
        ? access.resolve(f.a, "bob")
        : response === "update"
        ? access.update(f.a, {
          revision: view.revision,
          signature: view.signature,
          updateId,
          everybody: "view",
          grants: { [f.alice.id]: "none", [f.bob.id]: "admin" },
        })
        : access.outcome(f.a, updateId));
      operational = false;
      const error = await assertRejects(
        () =>
          f.read(body),
        HttpError,
        "HTTP 503",
      );
      assertEquals(error.status, 503);
      assertEquals(
        f.acl.capture().value.updateId,
        response === "update" ? updateId : view.updateId,
      );
    }));
}

Deno.test("vault access disclosure: an unread update capability snapshot cannot outlive a later ACL edit", () =>
  identityWorkflowFixture(async (f) => {
    const view = await f.read(f.access.view(f.a));
    const updateId = createUuid();
    const body = await f.access.update(f.a, {
      revision: view.revision,
      signature: view.signature,
      updateId,
      everybody: "none",
      grants: { [f.alice.id]: "view", [f.bob.id]: "admin" },
    });
    assertEquals(f.acl.effectiveLevel(f.a), "view");
    const outcome = f.access.outcome(f.a, updateId);
    f.policy({ [f.bob.id]: "admin" });
    await assertRejects(() => f.read(body), StoredConfigConflict, CONFLICT);
    await assertRejects(() => f.read(outcome), StoredConfigConflict, CONFLICT);
    assertEquals(await f.read(f.access.outcome(f.a, updateId)), {
      matched: false,
      capabilities: {
        canRead: false,
        canEdit: false,
        canManageVault: false,
        canManageOwnAccount: true,
        canCreateVault: true,
      },
    });
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
