// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { AccountRepository } from "../server/auth/accounts.ts";
import { AclRepository } from "../server/auth/acl.ts";
import {
  type AccountParticipantReceipt,
  AuthenticationError,
  type PreparedAccount,
} from "../server/auth/account_credentials.ts";
import { settledPublication } from "../server/config/internal/participant_completion.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import {
  createPublicationSet,
  type PublicationParticipant,
} from "../server/config/owned_publication.ts";
import {
  PublicationSetUnavailable,
  StoredConfigConflict,
} from "../server/config/publication_outcome.ts";
import { preparationFixture } from "./helpers/account_preparation.ts";
import { storedState, UPDATE, VAULT_A, VAULT_B } from "./helpers/identity.ts";
import { signIn } from "./helpers/session_delivery.ts";
import { OwnershipError } from "../shared/ownership.js";

const SET = "00000000-0000-4000-8000-000000000020";
const NEXT = "00000000-0000-4000-8000-000000000021";
const INVALID = "Invalid identity state; original bytes retained.";
const UNAVAILABLE =
  "Publication set is unavailable; settlement or recovery is required.";
const CONFLICT = "Stored configuration changed before commit.";
const MISSING_PEER = "Publication set is missing a required peer.";
const journalPath = (root: string) => `${root}/journal.json`;

function assertMissingPeer(
  root: string,
  parts: readonly PublicationParticipant[],
) {
  let unexpected: ReturnType<typeof createPublicationSet> | undefined;
  try {
    assertThrows(
      () => unexpected = createPublicationSet(SET, parts, journalPath(root)),
      TypeError,
      MISSING_PEER,
    );
  } finally {
    unexpected?.discard();
  }
}

for (const everybody of ["none", "view", "edit"] as const) {
  Deno.test(`account participation: inert preparation, exact settled setup pair and restart sign-in (${everybody})`, () =>
    preparationFixture(async (f) => {
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        f.authority("initial"),
        f.request(),
      );
      const before = f.accounts.capture();
      const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
        accounts: f.accounts,
      });
      acl.prepareParents();
      const aclBefore = acl.capture();
      const lifetime = createOperationLease("live", [() => undefined]);
      const parts: PublicationParticipant[] = [];
      let set: ReturnType<typeof createPublicationSet> | undefined;
      try {
        parts.push(
          acl.prepareInitialParticipant(
            prepared.identity,
            everybody,
            aclBefore,
            lifetime.lease,
            SET,
          ),
        );
        if (everybody === "none") assertMissingPeer(f.root, [parts[0]]);
        parts.push(
          f.accounts.credentials.prepareAccountParticipant(
            prepared.prepared,
            SET,
          ),
        );
        if (everybody === "none") assertMissingPeer(f.root, [parts[1]]);
        assertEquals(parts.map((part) => Object.keys(part)), [["discard"], [
          "discard",
        ]]);
        assertThrows(
          () => f.accounts.capture(),
          PublicationSetUnavailable,
          UNAVAILABLE,
        );
        assertThrows(
          () => acl.capture(),
          PublicationSetUnavailable,
          UNAVAILABLE,
        );
        assertEquals(
          [...Deno.readDirSync(f.root)].filter((e) =>
            e.name === "accounts.json"
          ),
          [],
        );
        set = createPublicationSet(SET, parts, journalPath(f.root));
        for (const part of parts) {
          assertThrows(
            () => settledPublication(part),
            PublicationSetUnavailable,
            UNAVAILABLE,
          );
        }
        for (const part of [{}, { ...parts[0] }]) {
          assertThrows(
            () => settledPublication(part),
            TypeError,
            "Completion requires an issued participant.",
          );
        }
        set.validate();
        assertEquals([
          before.value.initialized,
          before.value.accounts,
          aclBefore.value.grants,
        ], [false, [], {}]);
        set.decide();
        assertEquals(set.publish().state, "committed");
        assertThrows(
          () => settledPublication(parts[1]),
          PublicationSetUnavailable,
          UNAVAILABLE,
        );
        assertThrows(
          () => f.accounts.capture(),
          PublicationSetUnavailable,
          UNAVAILABLE,
        );
        assertThrows(
          () => acl.capture(),
          PublicationSetUnavailable,
          UNAVAILABLE,
        );
        assertEquals(set.release().state, "committed");
        const completion = settledPublication(parts[1]);
        assertStrictEquals(completion, settledPublication(parts[0]));
        assertStrictEquals(completion.members[0], parts[0]);
        assertStrictEquals(completion.members[1], parts[1]);
        assertEquals(completion.members.length, 2);
        assertEquals(f.accounts.capture().value, {
          version: 1,
          revision: 1,
          initialized: true,
          updateId: UPDATE,
          accounts: [prepared.identity],
          provisioning: [],
        });
        const expectedAcl = {
          version: 1,
          vaultId: VAULT_A,
          revision: 1,
          updateId: acl.capture().value.updateId,
          updateActorId: prepared.identity.id,
          everybody,
          grants: { [prepared.identity.id]: "admin" },
        } as const;
        assertEquals(acl.capture().value, expectedAcl);
        assertEquals(
          JSON.parse(Deno.readTextFileSync(`${f.root}/vault/access.json`)),
          expectedAcl,
        );
        const saved = storedState(f.accounts);
        assertEquals([
          saved.initialized,
          saved.accounts.map((
            a,
          ) => [
            a.id,
            a.login,
            a.passwordChangeRequired,
            a.totpKey,
            a.lastTotpStep,
          ]),
        ], [true, [[prepared.identity.id, "alice", false, null, null]]]);
        const reopened = new AccountRepository(f.root);
        assertEquals(reopened.byLogin("alice"), prepared.identity);
        await reopened.credentials.authenticate("alice", "password");
        f.signing.initialize();
        const session = await signIn(f.sessions, {
          username: "alice",
          password: "password",
        });
        assertEquals(
          (await f.sessions.validateToken(session.access_token)).accountId,
          prepared.identity.id,
        );
        assertThrows(
          () =>
            f.accounts.credentials.publishPreparedAccount(prepared.prepared),
          IdentityStateError,
          INVALID,
        );
        assertThrows(
          () =>
            f.accounts.credentials.prepareAccountParticipant(
              prepared.prepared,
              NEXT,
            ),
          IdentityStateError,
          INVALID,
        );
      } finally {
        set?.discard();
        for (const part of parts) part.discard();
        lifetime.retire();
      }
    }));
}

Deno.test("account participation: replacing the second member with identical bytes invalidates every completion lookup", () =>
  preparationFixture(async (f) => {
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request(),
    );
    const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
      accounts: f.accounts,
    });
    acl.prepareParents();
    const lifetime = createOperationLease("live", [() => undefined]);
    const parts: PublicationParticipant[] = [];
    let set: ReturnType<typeof createPublicationSet> | undefined;
    try {
      parts.push(acl.prepareInitialParticipant(
        prepared.identity,
        "none",
        acl.capture(),
        lifetime.lease,
        SET,
      ));
      parts.push(
        f.accounts.credentials.prepareAccountParticipant(
          prepared.prepared,
          SET,
        ),
      );
      set = createPublicationSet(SET, parts, journalPath(f.root));
      set.decide();
      assertEquals(set.publish().state, "committed");
      assertEquals(set.release().state, "committed");
      assertStrictEquals(
        settledPublication(parts[0]),
        settledPublication(parts[1]),
      );

      const file = `${f.root}/accounts.json`;
      const replacement = `${f.root}/replacement`;
      const raw = Deno.readTextFileSync(file);
      Deno.writeTextFileSync(replacement, raw);
      Deno.renameSync(replacement, file);
      for (const part of parts) {
        assertThrows(
          () => settledPublication(part),
          StoredConfigConflict,
          CONFLICT,
        );
      }
      assertEquals(Deno.readTextFileSync(file), raw);
    } finally {
      set?.discard();
      for (const part of parts) part.discard();
      lifetime.retire();
    }
  }));

for (const action of ["standalone", "set"] as const) {
  Deno.test(`account participation: undecided ${action} discard restores exact before state but never reuses preparation`, () =>
    preparationFixture(async (f) => {
      const before = f.accounts.capture();
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        f.authority("initial"),
        f.request(),
      );
      const parts: PublicationParticipant[] = [];
      const lifetime = createOperationLease("live", [() => undefined]);
      try {
        parts.push(
          f.accounts.credentials.prepareAccountParticipant(
            prepared.prepared,
            SET,
          ),
        );
        if (action === "standalone") {
          assertMissingPeer(f.root, parts);
          parts[0].discard();
        } else {
          const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
            accounts: f.accounts,
          });
          acl.prepareParents();
          const aclBefore = acl.capture();
          parts.push(acl.prepareInitialParticipant(
            prepared.identity,
            "none",
            aclBefore,
            lifetime.lease,
            SET,
          ));
          createPublicationSet(SET, parts, journalPath(f.root)).discard();
          assertStrictEquals(acl.capture(), aclBefore);
          assertEquals([...Deno.readDirSync(`${f.root}/vault`)], []);
        }
        assertStrictEquals(f.accounts.capture(), before);
        assertEquals(
          [...Deno.readDirSync(f.root)].map((e) => e.name),
          action === "standalone" ? [] : ["vault"],
        );
        assertThrows(
          () =>
            f.accounts.credentials.prepareAccountParticipant(
              prepared.prepared,
              SET,
            ),
          IdentityStateError,
          INVALID,
        );
      } finally {
        for (const part of parts) part.discard();
        lifetime.retire();
      }
    }));
}

Deno.test("account participation: forged, cloned and foreign preparations are rejected without effect", () =>
  preparationFixture(async (f) => {
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request(),
    );
    for (
      const value of [
        {},
        { ...prepared.prepared },
        structuredClone(prepared.prepared),
        prepared.identity,
        null,
      ]
    ) {
      assertThrows(
        () =>
          f.accounts.credentials.prepareAccountParticipant(
            value as PreparedAccount,
            SET,
          ),
        IdentityStateError,
        INVALID,
      );
    }
    await preparationFixture((other) => {
      assertThrows(
        () =>
          other.accounts.credentials.prepareAccountParticipant(
            prepared.prepared,
            SET,
          ),
        IdentityStateError,
        INVALID,
      );
      return Promise.resolve();
    });
    assertEquals(f.accounts.capture().value.accounts, []);
    const part = f.accounts.credentials.prepareAccountParticipant(
      prepared.prepared,
      SET,
    );
    part.discard();
  }));

for (
  const boundary of ["abort", "authority", "aggregate", "external"] as const
) {
  Deno.test(`account participation: ${boundary} after transfer prevents decision`, () =>
    preparationFixture(async (f) => {
      const abort = new AbortController();
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        f.authority("initial"),
        f.request(),
        abort.signal,
      );
      const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
        accounts: f.accounts,
      });
      acl.prepareParents();
      const aclBefore = acl.capture();
      const part = f.accounts.credentials.prepareAccountParticipant(
        prepared.prepared,
        SET,
      );
      const lifetime = createOperationLease("live", [() => undefined]);
      try {
        const access = acl.prepareInitialParticipant(
          prepared.identity,
          "none",
          aclBefore,
          lifetime.lease,
          SET,
        );
        let set: ReturnType<typeof createPublicationSet> | undefined;
        try {
          const pair = set = createPublicationSet(
            SET,
            [part, access],
            journalPath(f.root),
          );
          if (boundary === "abort") abort.abort();
          if (boundary === "authority") f.retire();
          if (boundary === "aggregate") f.accounts.retireCredentials();
          if (boundary === "external") {
            Deno.writeTextFileSync(`${f.root}/accounts.json`, "foreign");
          }
          if (boundary === "abort") {
            assertThrows(
              () => pair.decide(),
              AuthenticationError,
              "Invalid authentication credentials.",
            );
          } else if (boundary === "external") {
            assertThrows(
              () => pair.decide(),
              StoredConfigConflict,
              CONFLICT,
            );
          } else {
            assertThrows(
              () => pair.decide(),
              OwnershipError,
              "Owner is retired",
            );
          }
          assertThrows(
            () => pair.publish(),
            PublicationSetUnavailable,
            UNAVAILABLE,
          );
        } finally {
          set?.discard();
          access.discard();
        }
      } finally {
        part.discard();
        lifetime.retire();
      }
      assertEquals(f.accounts.capture().value.accounts, []);
      assertStrictEquals(acl.capture(), aclBefore);
      if (boundary === "external") {
        assertEquals(
          Deno.readTextFileSync(`${f.root}/accounts.json`),
          "foreign",
        );
      }
    }));
}

Deno.test("account participation: setup refuses an ACL for a different creator", () =>
  preparationFixture(async (f) => {
    const creator = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request(),
    );
    const other = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request({ login: "other" }),
    );
    const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
      accounts: f.accounts,
    });
    acl.prepareParents();
    const parts: PublicationParticipant[] = [];
    const lifetime = createOperationLease("live", [() => undefined]);
    try {
      parts.push(acl.prepareInitialParticipant(
        other.identity,
        "none",
        acl.capture(),
        lifetime.lease,
        SET,
      ));
      parts.push(
        f.accounts.credentials.prepareAccountParticipant(creator.prepared, SET),
      );
      assertMissingPeer(f.root, parts);
    } finally {
      for (const part of parts) part.discard();
      lifetime.retire();
    }
    assertEquals([
      f.accounts.capture().value.accounts,
      acl.capture().value.grants,
    ], [[], {}]);
  }));

Deno.test("account participation: recipient receipt requires its exact ACL peer and commits one account-marker-receipt replacement", () =>
  preparationFixture(async (f) => {
    const actor = await f.createInitial();
    const recipient = await f.accounts.credentials.preparePasswordOnlyRecipient(
      f.authority("recipient"),
      f.request({ login: "bob", updateId: NEXT }),
    );
    const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
      accounts: f.accounts,
    });
    acl.prepareParents();
    const before = acl.capture();
    const lifetime = createOperationLease("live", [() => undefined]);
    const grant = acl.prepareGrantParticipant(
      recipient.identity,
      "view",
      before,
      { updateId: NEXT, actorId: actor.id },
      lifetime.lease,
      SET,
    );
    let account: PublicationParticipant | undefined;
    let set: ReturnType<typeof createPublicationSet> | undefined;
    try {
      assertMissingPeer(f.root, [grant]);
      account = f.accounts.credentials.prepareAccountParticipant(
        recipient.prepared,
        SET,
        {
          acl: grant,
          actorId: actor.id,
          operationId: SET,
          payloadHash: "a".repeat(64),
        },
      );
      assertMissingPeer(f.root, [account]);
      set = createPublicationSet(SET, [account, grant], journalPath(f.root));
      set.decide();
      assertEquals(set.publish().state, "committed");
      assertEquals(set.release().state, "committed");
      assertEquals(storedState(f.accounts).provisioning, [{
        operationId: SET,
        actorId: actor.id,
        vaultId: VAULT_A,
        accountId: recipient.identity.id,
        payloadHash: "a".repeat(64),
        committed: true,
        level: "view",
        aclUpdateId: NEXT,
      }]);
      assertEquals(acl.capture().value.grants, {
        [recipient.identity.id]: "view",
      });
      assertEquals(
        new AccountRepository(f.root).byLogin("bob"),
        recipient.identity,
      );
      assertEquals(recipient.identity.passwordChangeRequired, true);
    } finally {
      set?.discard();
      account?.discard();
      grant.discard();
      lifetime.retire();
    }
  }));

for (
  const bad of [
    "initial purpose",
    "forged peer",
    "cloned peer",
    "null receipt",
    "missing receipt",
    "wrong recipient",
    "wrong actor",
    "wrong set",
  ] as const
) {
  Deno.test(`account participation: receipt rejects ${bad}`, () =>
    preparationFixture(async (f) => {
      const actor = await f.createInitial();
      const make = () =>
        f.accounts.credentials.preparePasswordOnlyRecipient(
          f.authority("recipient"),
          f.request({ login: "bob", updateId: NEXT }),
        );
      const recipient = await make();
      const other = await f.accounts.credentials.preparePasswordOnlyRecipient(
        f.authority("recipient"),
        f.request({ login: "charlie", updateId: NEXT }),
      );
      const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
        accounts: f.accounts,
      });
      acl.prepareParents();
      const lifetime = createOperationLease("live", [() => undefined]);
      const grant = acl.prepareGrantParticipant(
        bad === "wrong recipient" ? other.identity : recipient.identity,
        "edit",
        acl.capture(),
        { updateId: NEXT, actorId: actor.id },
        lifetime.lease,
        bad === "wrong set" ? NEXT : SET,
      );
      try {
        if (bad === "initial purpose") {
          await preparationFixture(async (fresh) => {
            const initial = await fresh.accounts.credentials
              .prepareInitialAccount(
                fresh.authority("initial"),
                fresh.request(),
              );
            assertThrows(
              () =>
                fresh.accounts.credentials.prepareAccountParticipant(
                  initial.prepared,
                  SET,
                  {
                    acl: grant,
                    actorId: actor.id,
                    operationId: SET,
                    payloadHash: "a".repeat(64),
                  },
                ),
              IdentityStateError,
              INVALID,
            );
          });
        } else if (bad === "wrong set") {
          const account = f.accounts.credentials.prepareAccountParticipant(
            recipient.prepared,
            SET,
            {
              acl: grant,
              actorId: actor.id,
              operationId: SET,
              payloadHash: "a".repeat(64),
            },
          );
          try {
            assertThrows(
              () =>
                createPublicationSet(
                  SET,
                  [account, grant],
                  journalPath(f.root),
                ),
              StoredConfigConflict,
              CONFLICT,
            );
          } finally {
            account.discard();
          }
        } else if (bad === "null receipt" || bad === "missing receipt") {
          assertThrows(
            () =>
              f.accounts.credentials.prepareAccountParticipant(
                recipient.prepared,
                SET,
                bad === "null receipt"
                  ? null as unknown as AccountParticipantReceipt
                  : undefined,
              ),
            IdentityStateError,
            INVALID,
          );
        } else {
          assertThrows(
            () =>
              f.accounts.credentials.prepareAccountParticipant(
                recipient.prepared,
                SET,
                {
                  acl: bad === "forged peer"
                    ? {} as PublicationParticipant
                    : bad === "cloned peer"
                    ? { ...grant }
                    : grant,
                  actorId: bad === "wrong actor" ? VAULT_B : actor.id,
                  operationId: SET,
                  payloadHash: "a".repeat(64),
                },
              ),
            IdentityStateError,
            INVALID,
          );
        }
      } finally {
        grant.discard();
        lifetime.retire();
      }
      assertEquals(f.accounts.capture().value.accounts, [actor]);
      assertEquals(storedState(f.accounts).provisioning, []);
    }));
}

Deno.test("account participation: a temporary identity cannot become the setup creator", () =>
  preparationFixture(async (f) => {
    await f.createInitial();
    const recipient = await f.accounts.credentials.preparePasswordOnlyRecipient(
      f.authority("recipient"),
      f.request({ login: "bob" }),
    );
    const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
      accounts: f.accounts,
    });
    acl.prepareParents();
    const lifetime = createOperationLease("live", [() => undefined]);
    try {
      assertThrows(
        () =>
          acl.prepareInitialParticipant(
            recipient.identity,
            "none",
            acl.capture(),
            lifetime.lease,
            SET,
          ),
        IdentityStateError,
        INVALID,
      );
      await assertRejects(
        () => f.accounts.credentials.authenticate("bob", "password"),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    } finally {
      lifetime.retire();
    }
  }));

Deno.test("account participation: malformed committed receipts retain the exact saved bytes", () =>
  preparationFixture(async (f) => {
    const actor = await f.createInitial();
    const saved = storedState(f.accounts);
    const receipt = {
      operationId: SET,
      actorId: actor.id,
      vaultId: VAULT_A,
      accountId: actor.id,
      payloadHash: "a".repeat(64),
      committed: true,
      level: "view",
      aclUpdateId: NEXT,
    };
    for (
      const provisioning of [
        [{ ...receipt, committed: false }],
        [{ ...receipt, actorId: VAULT_B }],
        [{ ...receipt, level: "owner" }],
        [{ ...receipt, aclUpdateId: null }],
        [{ ...receipt, payloadHash: "password" }],
        [{ ...receipt, extra: true }],
        [receipt, receipt],
      ]
    ) {
      const raw = JSON.stringify({ ...saved, provisioning });
      Deno.writeTextFileSync(`${f.root}/accounts.json`, raw);
      assertThrows(
        () => new AccountRepository(f.root),
        IdentityStateError,
        INVALID,
      );
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), raw);
    }
  }));
