// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { AclRepository } from "../server/auth/acl.ts";
import { InstanceAuthority } from "../server/auth/authority.ts";
import { bindAccountPreparationAuthority } from "../server/auth/internal/account_credentials.ts";
import {
  createPublicationSet,
  type PublicationParticipant,
} from "../server/config/owned_publication.ts";
import { PublicationSetUnavailable } from "../server/config/publication_outcome.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import {
  preparationContext,
  preparationFixture,
} from "./helpers/account_preparation.ts";
import {
  identityFixture,
  UPDATE,
  VAULT_A,
  VAULT_B,
} from "./helpers/identity.ts";
import { spawnOwnedChild } from "./helpers/owned_child.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { OwnershipError } from "../shared/ownership.js";
import { HttpError } from "@pathfinder/pathfinder";
import { OperationError } from "../server/plugins/errors.ts";
import { StoredConfigConflict } from "../server/config/publication_outcome.ts";
import { GUEST, InstanceSessions } from "../server/auth/sessions.ts";
import type {
  AuthorityCallback,
  AuthorityReadContext,
} from "../server/auth/authority_context.ts";
import { readAuthorityState } from "../server/auth/authority_context.ts";
import type { AuthorityVault } from "../server/auth/authority.ts";

const SET = "00000000-0000-4000-8000-000000000071";
const unavailable =
  "Publication set is unavailable; settlement or recovery is required.";

Deno.test("participant authority: ACL without a declared Admin does not need a held account directory", () =>
  preparationFixture(async (f) => {
    const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
      accounts: f.accounts,
    });
    acl.prepareParents();
    acl.save({ everybody: "view", grants: {} }, acl.capture(), {
      updateId: UPDATE,
      actorId: null,
    });
    const target = new AclRepository(`${f.root}/target`, VAULT_B, {
      accounts: f.accounts,
    });
    target.prepareParents();
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request(),
    );
    const lifetime = createOperationLease("live", [() => undefined]);
    const vault = {
      identity: {},
      id: VAULT_A,
      acl,
      lifecycle: { epoch: 0, operational: () => true },
    };
    let account: PublicationParticipant | undefined;
    let access: PublicationParticipant | undefined;
    try {
      const guest = new InstanceAuthority(
        f.sessions,
        () => vault,
        lifetime.lease,
      )
        .lease(GUEST, "readVault");
      account = f.accounts.credentials.prepareAccountParticipant(
        prepared.prepared,
        SET,
      );
      assertThrows(
        () => f.accounts.capture(),
        PublicationSetUnavailable,
        unavailable,
      );
      const before = target.capture();
      access = target.prepareInitialParticipant(
        prepared.identity,
        "none",
        before,
        guest.lease,
        UPDATE,
      );
      access.discard();
      assertStrictEquals(target.capture(), before);
    } finally {
      access?.discard();
      account?.discard();
      lifetime.retire();
    }
  }));

for (
  const mode of [
    "committed",
    "identity eligibility",
    "selector eligibility",
    "clock eligibility",
    "context propagation",
    "context-free eligibility",
    "context-free selector",
    "context-free clock",
    "context-free principal",
    "eligibility revoked",
    "eligibility retirement",
    "declared admin",
    "retired preparation",
    "retired decision",
    "retired publication",
    "account replacement",
    "ACL replacement",
    "expiry",
    "lifecycle",
    "reentrant outside",
  ] as const
) {
  const exercise = (fixture: typeof preparationFixture) =>
    fixture(async (f) => {
      const alice = await f.createInitial();
      f.signing.initialize();
      let now = 1_800_000_000_000;
      let observe:
        | ((context: AuthorityReadContext, callback: string) => void)
        | undefined;
      const sessions = new InstanceSessions(f.accounts, f.signing, {
        expirySeconds: 3600,
      }, {
        now: (context) => {
          observe?.(context, "clock");
          if (mode === "context-free clock") {
            assertEquals(sessions.accounts.initialized, true);
          }
          if (mode === "clock eligibility") {
            assertEquals(context.accounts(f.accounts).value.initialized, true);
          }
          return now;
        },
      });
      const session = await signIn(sessions, {
        username: "alice",
        password: "password",
      });
      const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
        accounts: f.accounts,
        ...(mode === "declared admin" ? { declaredAdmin: "alice" } : {}),
      });
      acl.prepareParents();
      acl.initializeForCreator(alice, "none");
      let probe: (() => void) | undefined;
      const lifetime = createOperationLease("live", [() => {
        probe?.();
        return undefined;
      }]);
      const parts: PublicationParticipant[] = [];
      if (mode === "context-free principal") {
        const current = sessions.assertCurrent.bind(sessions);
        sessions.assertCurrent = (principal) => current(principal);
      }
      let set: ReturnType<typeof createPublicationSet> | undefined;
      try {
        let eligible = true, retireEligibility = false, collecting = false;
        let retained: AuthorityReadContext | undefined;
        const callbacks = new Map<AuthorityReadContext, string[]>();
        const service: { operational: AuthorityCallback<boolean> } = {
          operational(context) {
            const ready =
              context.accounts(sessions.accounts).value.initialized &&
              context.signing(sessions.signing).initialized;
            if (retireEligibility) lifetime.retire();
            return ready && eligible;
          },
        };
        const vault: AuthorityVault & {
          lifecycle: { epoch: number; operational: AuthorityCallback<boolean> };
        } = {
          identity: {},
          id: VAULT_A,
          acl,
          lifecycle: {
            epoch: 0,
            operational: (context) => {
              observe?.(context, "lifecycle");
              if (mode === "context-free eligibility") {
                try {
                  if (!sessions.accounts.initialized) return false;
                  sessions.signing.current();
                  return true;
                } catch {
                  return false;
                }
              }
              return service.operational(context);
            },
          },
        };
        observe = (context, callback) => {
          if (mode !== "context propagation" || !collecting) return;
          assertThrows(
            () => readAuthorityState((ordinary) => ordinary.acl(acl)),
            PublicationSetUnavailable,
            unavailable,
          );
          // Actual callback reads are qualified, not a constant eligibility result.
          assertEquals(context.accounts(f.accounts).value.accounts, [alice]);
          assertEquals(context.acl(acl).snapshot.value.grants, {
            [alice.id]: "admin",
          });
          assertEquals(context.signing(f.signing), {
            initialized: true,
            signingRevision: 1,
          });
          if (retained && retained !== context) {
            assertThrows(
              () => retained!.accounts(f.accounts),
              PublicationSetUnavailable,
              unavailable,
            );
          }
          retained = context;
          const list = callbacks.get(context) ?? [];
          list.push(callback);
          callbacks.set(context, list);
        };
        const select: AuthorityCallback<AuthorityVault | null> = (context) => {
          observe?.(context, "selector");
          if (
            mode === "selector eligibility" && !service.operational(context)
          ) return null;
          if (
            mode === "context-free selector" && !sessions.accounts.initialized
          ) return null;
          return vault;
        };
        const authority = new InstanceAuthority(
          sessions,
          select,
          lifetime.lease,
        );
        const admin = authority.lease(session.principal, "manageVault");
        const recipient = await f.accounts.credentials
          .preparePasswordOnlyRecipient(
            bindAccountPreparationAuthority(
              f.accounts.credentials,
              "recipient",
              admin.lease,
            ),
            f.request({ login: "recipient", updateId: SET }),
          );
        const aclBefore = acl.capture();
        const accountBytes = Deno.readTextFileSync(`${f.root}/accounts.json`);
        admin.assertCurrent(SET);
        if (mode === "retired preparation") {
          lifetime.retire();
          assertThrows(
            () =>
              acl.prepareGrantParticipant(
                recipient.identity,
                "edit",
                aclBefore,
                { updateId: SET, actorId: alice.id },
                admin.lease,
                SET,
              ),
            OwnershipError,
            "Owner is retired",
          );
          assertStrictEquals(acl.capture(), aclBefore);
          assertEquals(
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            accountBytes,
          );
          return;
        }
        const access = acl.prepareGrantParticipant(
          recipient.identity,
          "edit",
          aclBefore,
          { updateId: SET, actorId: alice.id },
          admin.lease,
          SET,
        );
        parts.push(access);
        collecting = true;
        assertThrows(
          () => acl.capture(),
          PublicationSetUnavailable,
          unavailable,
        );
        let probes = 0;
        if (mode === "reentrant outside") {
          probe = () => {
            probes++;
            assertThrows(
              () => acl.capture(),
              PublicationSetUnavailable,
              unavailable,
            );
            // The public lease API never borrows the native validation context.
            const current = probe;
            probe = undefined;
            try {
              assertThrows(
                () => admin.assertCurrent(),
                PublicationSetUnavailable,
                unavailable,
              );
            } finally {
              probe = current;
            }
          };
        }
        const prepareAccount = () =>
          f.accounts.credentials.prepareAccountParticipant(
            recipient.prepared,
            SET,
            {
              acl: access,
              actorId: alice.id,
              operationId: SET,
              payloadHash: "a".repeat(64),
            },
          );
        if (
          mode === "context-free eligibility" ||
          mode === "context-free selector" || mode === "context-free clock" ||
          mode === "context-free principal"
        ) {
          if (mode === "context-free eligibility") {
            assertThrows(prepareAccount, HttpError, "HTTP 503");
          } else {assertThrows(
              prepareAccount,
              PublicationSetUnavailable,
              unavailable,
            );}
          assertEquals(
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            accountBytes,
          );
          assertEquals(
            Deno.readTextFileSync(`${f.root}/vault/access.json`),
            aclBefore.persistence.raw,
          );
          return;
        }
        const account = prepareAccount();
        parts.push(account);
        assertThrows(
          () => f.accounts.capture(),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => acl.capture(),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => admin.assertCurrent(SET),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => sessions.assertCurrent(session.principal),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => authority.capabilities(session.principal),
          PublicationSetUnavailable,
          unavailable,
        );
        set = createPublicationSet(
          SET,
          [account, access],
          `${f.root}/journal.json`,
        );
        set.validate();
        assertThrows(
          () => acl.capture(),
          PublicationSetUnavailable,
          unavailable,
        );
        if (mode === "retired decision") lifetime.retire();
        if (mode === "account replacement" || mode === "ACL replacement") {
          const file = mode === "account replacement"
            ? `${f.root}/accounts.json`
            : `${f.root}/vault/access.json`;
          const raw = Deno.readTextFileSync(file);
          Deno.writeTextFileSync(`${f.root}/replacement`, raw);
          Deno.renameSync(`${f.root}/replacement`, file);
        }
        if (mode === "expiry") now += 3_600_000;
        if (mode === "lifecycle") vault.lifecycle.epoch++;
        if (mode === "eligibility revoked") eligible = false;
        if (mode === "eligibility retirement") retireEligibility = true;
        if (
          [
            "retired decision",
            "account replacement",
            "ACL replacement",
            "lifecycle",
            "expiry",
            "eligibility revoked",
            "eligibility retirement",
          ].includes(mode)
        ) {
          if (
            mode === "retired decision" || mode === "eligibility retirement"
          ) {
            assertThrows(
              () => set!.decide(),
              OwnershipError,
              "Owner is retired",
            );
          } else if (mode === "lifecycle") {
            assertThrows(
              () => set!.decide(),
              OperationError,
              "Access policy changed while this operation was pending; it was not applied.",
            );
          } else if (mode === "expiry") {
            assertThrows(() => set!.decide(), HttpError, "HTTP 401");
          } else if (mode === "eligibility revoked") {
            assertThrows(() => set!.decide(), HttpError, "HTTP 503");
          } else {assertThrows(
              () => set!.decide(),
              StoredConfigConflict,
              "Stored configuration changed before commit.",
            );}
          assertEquals([
            Deno.readTextFileSync(`${f.root}/accounts.json`),
            Deno.readTextFileSync(`${f.root}/vault/access.json`),
          ], [accountBytes, aclBefore.persistence.raw]);
          set.discard();
          assertEquals(f.accounts.byLogin("recipient"), null);
          assertEquals(acl.capture().value, aclBefore.value);
          return;
        }
        set.decide();
        if (mode === "retired publication") {
          lifetime.retire();
          assertEquals(set.publish().state, "recovery-required");
          assertThrows(
            () => acl.capture(),
            PublicationSetUnavailable,
            unavailable,
          );
          assertEquals(
            [
              Deno.readTextFileSync(`${f.root}/accounts.json`),
              Deno.readTextFileSync(`${f.root}/vault/access.json`),
            ],
            [accountBytes, aclBefore.persistence.raw],
          );
          return;
        }
        assertEquals(set.publish().state, "committed");
        assertThrows(
          () => acl.capture(),
          PublicationSetUnavailable,
          unavailable,
        );
        collecting = false;
        set.release();
        assertEquals(f.accounts.byLogin("recipient"), recipient.identity);
        assertEquals(acl.capture().value.grants, {
          [alice.id]: "admin",
          [recipient.identity.id]: "edit",
        });
        assertEquals(f.accounts.capture().value.provisioning, [{
          operationId: SET,
          actorId: alice.id,
          vaultId: VAULT_A,
          accountId: recipient.identity.id,
          payloadHash: "a".repeat(64),
          committed: true,
          level: "edit",
          aclUpdateId: SET,
        }]);
        if (mode === "reentrant outside") assertEquals(probes > 4, true);
        if (mode === "context propagation") {
          assertEquals(callbacks.size > 1, true);
          for (const list of callbacks.values()) {
            assertEquals(list, ["clock", "selector", "clock", "lifecycle"]);
          }
          assertThrows(
            () => retained!.accounts(f.accounts),
            PublicationSetUnavailable,
            unavailable,
          );
        }
      } finally {
        set?.discard();
        for (const part of parts) part.discard();
        lifetime.retire();
      }
    });
  if (import.meta.main) {
    if (mode === "retired publication") {
      const [root] = Deno.args;
      if (!root) throw new Error("Expected the parent fixture root.");
      await exercise(async (run) => {
        const fixture = preparationContext(root, {});
        try {
          await run(fixture);
        } finally {
          fixture.retire();
          fixture.accounts.retireCredentials();
        }
      });
    }
  } else {
    Deno.test(`participant authority: actual Admin grant/account pair ${mode}`, () =>
      mode !== "retired publication"
        ? exercise(preparationFixture)
        : identityFixture(async (root, scope) => {
          // A decided set must remain fenced for recovery; its open candidates
          // belong to this child until exit. Reap it before removing the root.
          const child = (await spawnOwnedChild(scope, Deno.execPath(), {
            args: [
              "run",
              "--allow-read",
              "--allow-write",
              "--allow-env",
              fromFileUrl(import.meta.url),
              root,
            ],
            stdout: "null",
            stderr: "piped",
          })).value;
          const [status, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          assertEquals([status.success, status.code, status.signal, stderr], [
            true,
            0,
            null,
            "",
          ]);
        }));
  }
}

Deno.test("authority callback contract: validation callback calls require an issued read context", () => {
  const typeContract = (
    vault: AuthorityVault,
    select: AuthorityCallback<AuthorityVault | null>,
    context: AuthorityReadContext,
    principal: Parameters<AuthorityReadContext["assertPrincipal"]>[1],
  ) => {
    // @ts-expect-error Lifecycle validation cannot omit its read context.
    vault.lifecycle.operational();
    // @ts-expect-error Selector validation cannot omit its read context.
    select();
    // @ts-expect-error ACL validation cannot omit its read context.
    context.acl(vault.acl).effectiveLevel(principal);
    // @ts-expect-error Contexts are issued, not caller-built DTOs.
    const forged: AuthorityReadContext = {};
    void forged;
    const clock: AuthorityCallback<number> = () => 0;
    // @ts-expect-error A clock participating in validation receives its context.
    clock();
  };
  void typeContract;
});

Deno.test("authority callback contract: an ordinary context expires on return and cannot become background authority", () =>
  preparationFixture(async (f) => {
    const alice = await f.createInitial();
    f.signing.initialize();
    let retained: AuthorityReadContext | undefined;
    const accounts = readAuthorityState((context) => {
      retained = context;
      assertEquals(context.signing(f.signing), {
        initialized: true,
        signingRevision: 1,
      });
      return context.accounts(f.accounts);
    });
    assertEquals(accounts.value.accounts, [alice]);
    assertThrows(
      () => retained!.accounts(f.accounts),
      PublicationSetUnavailable,
      unavailable,
    );
  }));
