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
  type InitialAccountPreparationRequest,
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
import { heldOperation } from "./helpers/owned_operation.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { fixturePasswordHash } from "./helpers/config.ts";
import { SignJWT } from "jose";
import { receiveSession } from "./helpers/session_delivery.ts";
import { resetFixturePassword } from "./helpers/account_preparation.ts";
import type {
  InitialAccountProof,
  LoginProof,
} from "../server/auth/account_credentials.ts";
import type { AccountIdentity } from "../server/auth/accounts.ts";
import { InstanceSessions } from "../server/auth/sessions.ts";
import type { AccountPreparationAuthority } from "../server/auth/account_credentials.ts";

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
      assertThrows(
        () => f.accounts.credentials.initialAccountProof(account!, grant),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
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

const SETUP_NOW = 1_800_000_000_000;
const setupOptions = {
  now: () => SETUP_NOW,
  renderQr: (uri: string) => Promise.resolve(`qr:${uri}`),
};

Deno.test("setup enrollment: an explicit undefined authenticator is rejected without writes", () => {
  let hashes = 0;
  return preparationFixture(async (f) => {
    const source = f.authority("initial");
    const before = f.accounts.capture();
    const request = { ...f.request(), authenticator: undefined };
    // @ts-expect-error A known undefined property is not a password-only request.
    const invalidRequest: InitialAccountPreparationRequest = request;
    await assertRejects(
      () =>
        f.accounts.credentials.prepareInitialAccount(source, invalidRequest),
      IdentityStateError,
      INVALID,
    );
    assertEquals(hashes, 0);
    assertStrictEquals(f.accounts.capture(), before);
    assertEquals([...Deno.readDirSync(f.root)], []);
  }, {
    ...setupOptions,
    hash: (password) => {
      hashes++;
      return Promise.resolve(fixturePasswordHash(password));
    },
  });
});

function withEnrolledSetupPair(
  accounts: AccountRepository,
  prepared: Awaited<
    ReturnType<typeof accounts.credentials.prepareInitialAccount>
  >,
  run: (set: ReturnType<typeof createPublicationSet>) => void,
) {
  const acl = new AclRepository(`${accounts.root}/vault`, VAULT_A, {
    accounts,
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
      accounts.credentials.prepareAccountParticipant(prepared.prepared, SET),
    );
    set = createPublicationSet(SET, parts, journalPath(accounts.root));
    run(set);
  } finally {
    set?.discard();
    for (const part of parts) part.discard();
    lifetime.retire();
  }
  return acl.capture().value;
}

function publishEnrolledSetup(
  accounts: AccountRepository,
  prepared: Awaited<
    ReturnType<typeof accounts.credentials.prepareInitialAccount>
  >,
) {
  const acl = withEnrolledSetupPair(accounts, prepared, (pair) => {
    pair.decide();
    assertEquals(pair.publish().state, "committed");
    assertEquals(pair.release().state, "committed");
  });
  assertEquals(acl.grants, { [prepared.identity.id]: "admin" });
}

type PreparationFixture = Parameters<
  Parameters<typeof preparationFixture>[0]
>[0];
interface BootstrapPair {
  readonly f: PreparationFixture;
  readonly account: PublicationParticipant;
  readonly access: PublicationParticipant;
  readonly acl: AclRepository;
  readonly set: ReturnType<typeof createPublicationSet>;
  readonly owner: ReturnType<typeof createOperationLease<"live">>;
  readonly identity: AccountIdentity;
  readonly code: string | undefined;
  readonly abort: AbortController;
  proof(): InitialAccountProof;
  settle(): void;
}
function bootstrapPair(
  run: (pair: BootstrapPair) => Promise<void> | void,
  options: { totp?: boolean; completion?: boolean; witness?: () => undefined } =
    {},
) {
  return preparationFixture(async (f) => {
    const owner = createOperationLease("live", [
      options.witness ?? (() => undefined),
    ]);
    const abort = new AbortController();
    const parts: PublicationParticipant[] = [];
    let set: ReturnType<typeof createPublicationSet> | undefined;
    try {
      f.signing.initialize();
      const source = f.authority(
        "initial",
        options.completion === false ? undefined : owner.lease,
      );
      const bundle = options.totp
        ? await f.accounts.credentials.beginInitialEnrollment(source, "alice")
        : undefined;
      const code = bundle
        ? await authenticatorCode(bundle.secret, SETUP_NOW)
        : undefined;
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        source,
        bundle
          ? { ...f.request(), authenticator: { key: bundle.key, code: code! } }
          : f.request(),
        abort.signal,
      );
      const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
        accounts: f.accounts,
      });
      acl.prepareParents();
      const access = acl.prepareInitialParticipant(
        prepared.identity,
        "view",
        acl.capture(),
        owner.lease,
        SET,
      );
      parts.push(access);
      const account = f.accounts.credentials.prepareAccountParticipant(
        prepared.prepared,
        SET,
      );
      parts.push(account);
      set = createPublicationSet(SET, [account, access], journalPath(f.root));
      const publication = set;
      await run({
        f,
        owner,
        account,
        access,
        acl,
        set,
        code,
        abort,
        identity: prepared.identity,
        proof: () =>
          f.accounts.credentials.initialAccountProof(account, access),
        settle() {
          publication.decide();
          assertEquals(publication.publish().state, "committed");
          assertEquals(publication.release().state, "committed");
        },
      });
    } finally {
      set?.discard();
      for (const part of parts) part.discard();
      owner.retire();
    }
  }, setupOptions);
}

Deno.test("bootstrap proof: reentrant completion witness cannot mint a second proof", () => {
  let reenter: (() => undefined) | undefined;
  const events: string[] = [];
  return bootstrapPair(async (p) => {
    p.settle();
    reenter = () => {
      reenter = undefined;
      assertThrows(
        () => p.proof(),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      events.push("nested refused");
      return undefined;
    };
    const proof = p.proof();
    assertEquals(events, ["nested refused"]);
    const body = await receiveSession(await p.f.sessions.issue(proof));
    assertEquals(body.principal.accountId, p.identity.id);
  }, {
    witness: () => {
      reenter?.();
      return undefined;
    },
  });
});

Deno.test("bootstrap proof: completion owner survives the intentional end of initial admission freshness", () =>
  preparationFixture(async (f) => {
    let fresh = true;
    const admission = createOperationLease("live", [() => {
      if (!fresh) throw new Error("initial admission ended");
      return undefined;
    }]);
    const owner = createOperationLease("live", [() => undefined]);
    let set: ReturnType<typeof createPublicationSet> | undefined;
    const parts: PublicationParticipant[] = [];
    try {
      f.signing.initialize();
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        f.authority("initial", owner.lease, admission.lease),
        f.request(),
      );
      const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
        accounts: f.accounts,
      });
      acl.prepareParents();
      const access = acl.prepareInitialParticipant(
        prepared.identity,
        "none",
        acl.capture(),
        owner.lease,
        SET,
      );
      parts.push(access);
      const account = f.accounts.credentials.prepareAccountParticipant(
        prepared.prepared,
        SET,
      );
      parts.push(account);
      set = createPublicationSet(SET, [account, access], journalPath(f.root));
      set.decide();
      set.publish();
      set.release();
      fresh = false;
      assertThrows(
        () => admission.lease.assertCurrent(),
        Error,
        "initial admission ended",
      );
      const proof = f.accounts.credentials.initialAccountProof(account, access);
      const body = await receiveSession(await f.sessions.issue(proof));
      assertEquals(body.principal.accountId, prepared.identity.id);
      assertEquals(acl.capture().value, {
        version: 1,
        vaultId: VAULT_A,
        revision: 1,
        updateId: acl.capture().value.updateId,
        updateActorId: prepared.identity.id,
        everybody: "none",
        grants: { [prepared.identity.id]: "admin" },
      });
    } finally {
      set?.discard();
      for (const part of parts) part.discard();
      owner.retire();
      admission.retire();
    }
  }));

Deno.test("bootstrap proof: reentrant final session clock retires owner before native enqueue", () =>
  bootstrapPair(async (p) => {
    p.settle();
    let retire = false;
    const sessions = new InstanceSessions(p.f.accounts, p.f.signing, {
      expirySeconds: 86400,
    }, {
      now: () => {
        if (retire) p.owner.retire();
        return SETUP_NOW;
      },
    });
    const issued = await sessions.issue(p.proof());
    retire = true;
    await assertRejects(
      () => receiveSession(issued),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
  }));

for (const totp of [false, true]) {
  Deno.test(`bootstrap proof: exact settled pair reaches the existing signer and guarded body without another code (${totp})`, () =>
    bootstrapPair(async (p) => {
      p.settle();
      const before = storedState(p.f.accounts);
      const proof = p.proof();
      const typeContract = (): LoginProof => {
        // @ts-expect-error Initial publication and password verification have distinct proof brands.
        return proof;
      };
      void typeContract;
      assertEquals([Object.keys(proof), Object.isFrozen(proof)], [[], true]);
      const sign = SignJWT.prototype.sign;
      const calls: string[] = [];
      SignJWT.prototype.sign = function (...args) {
        calls.push("sign");
        return sign.apply(this, args);
      };
      let issued: Awaited<ReturnType<typeof p.f.sessions.issue>>;
      try {
        issued = await p.f.sessions.issue(proof);
      } finally {
        SignJWT.prototype.sign = sign;
      }
      assertEquals(calls, ["sign"]);
      const body = await receiveSession(issued);
      assertEquals(body.principal.accountId, p.identity.id);
      assertEquals(
        (await p.f.sessions.validateToken(body.access_token)).accountId,
        p.identity.id,
      );
      assertEquals(storedState(p.f.accounts), before);
      await assertRejects(
        () => p.f.sessions.issue(proof),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      assertThrows(
        () => p.proof(),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      const restarted = new AccountRepository(p.f.root, undefined, {
        now: () => SETUP_NOW + 30_000,
      });
      if (!totp) await restarted.credentials.authenticate("alice", "password");
      else {
        const key = storedState(restarted).accounts[0].totpKey!;
        await restarted.credentials.authenticate(
          "alice",
          "password",
          await authenticatorCode(key, SETUP_NOW + 30_000),
        );
      }
    }, { totp }));
}

Deno.test("bootstrap proof: missing owner, account-only, uninstalled and unreleased publication cannot mint", async () => {
  await bootstrapPair((p) => {
    p.set.discard();
    assertThrows(
      () => p.proof(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
  });
  await bootstrapPair((p) => {
    assertThrows(
      () => p.proof(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    p.set.decide();
    assertThrows(
      () => p.proof(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    assertEquals(p.set.publish().state, "committed");
    assertThrows(
      () => p.proof(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    p.set.release();
    assertEquals(Object.keys(p.proof()), []);
  });
  await bootstrapPair((p) => {
    p.settle();
    assertThrows(
      () => p.proof(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
  }, { completion: false });
  await preparationFixture(async (f) => {
    const owner = createOperationLease("live", [() => undefined]);
    let account: PublicationParticipant | undefined;
    try {
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        f.authority("initial", owner.lease),
        f.request(),
      );
      const participant = account = f.accounts.credentials
        .prepareAccountParticipant(
          prepared.prepared,
          SET,
        );
      assertMissingPeer(f.root, [participant]);
      assertThrows(
        () =>
          f.accounts.credentials.initialAccountProof(
            participant,
            {} as PublicationParticipant,
          ),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    } finally {
      account?.discard();
      owner.retire();
    }
  });
});

Deno.test("bootstrap proof: another root's real settled ACL is not the matching setup peer", () =>
  bootstrapPair(async (p) => {
    p.settle();
    await bootstrapPair((other) => {
      other.settle();
      assertThrows(
        () =>
          p.f.accounts.credentials.initialAccountProof(p.account, other.access),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    });
    const body = await receiveSession(await p.f.sessions.issue(p.proof()));
    assertEquals(body.principal.accountId, p.identity.id);
  }));

Deno.test("bootstrap proof: signing failure retires its proof but keeps normal sign-in available", () =>
  bootstrapPair(async (p) => {
    p.settle();
    const proof = p.proof();
    const sign = SignJWT.prototype.sign;
    SignJWT.prototype.sign = () => {
      SignJWT.prototype.sign = sign;
      return Promise.reject(new Error("fixture signer failed"));
    };
    try {
      await assertRejects(
        () => p.f.sessions.issue(proof),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    } finally {
      SignJWT.prototype.sign = sign;
    }
    await assertRejects(
      () => p.f.sessions.issue(proof),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    const session = await signIn(p.f.sessions, {
      username: "alice",
      password: "password",
    });
    assertEquals(session.principal.accountId, p.identity.id);
  }));

Deno.test("bootstrap proof: forged, cloned, foreign and wrong-purpose values never reach signing", () =>
  bootstrapPair(async (p) => {
    p.settle();
    for (
      const [account, access] of [
        [{}, p.access],
        [{ ...p.account }, p.access],
        [p.account, {}],
        [p.account, { ...p.access }],
      ]
    ) {
      assertThrows(
        () =>
          p.f.accounts.credentials.initialAccountProof(
            account as PublicationParticipant,
            access as PublicationParticipant,
          ),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    }
    const proof = p.proof();
    for (
      const value of [
        {},
        { ...proof },
        structuredClone(proof),
        p.identity,
        p.account,
        { committed: true },
        null,
      ]
    ) {
      await assertRejects(
        () => p.f.sessions.issue(value as InitialAccountProof),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    }
    await preparationFixture(async (foreign) => {
      foreign.signing.initialize();
      await assertRejects(
        () => foreign.sessions.issue(proof),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      assertThrows(
        () =>
          foreign.accounts.credentials.initialAccountProof(p.account, p.access),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    });
    // A stored account and a valid ordinary LoginProof remain different from
    // initial publication evidence; neither can mint an initial proof.
    const login = await p.f.accounts.credentials.authenticate(
      "alice",
      "password",
    );
    assertThrows(
      () =>
        p.f.accounts.credentials.initialAccountProof(
          login as unknown as PublicationParticipant,
          p.access,
        ),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    const ordinary = await receiveSession(await p.f.sessions.issue(login));
    assertEquals(ordinary.principal.accountId, p.identity.id);
    const initial = await receiveSession(await p.f.sessions.issue(proof));
    assertEquals(initial.principal.accountId, p.identity.id);
  }));

for (
  const boundary of [
    "owner",
    "aggregate",
    "account",
    "acl",
    "signing",
    "abort",
  ] as const
) {
  Deno.test(`bootstrap proof: held signing ${boundary} prevents session disclosure`, () =>
    bootstrapPair(async (p) => {
      p.settle();
      const proof = p.proof();
      await heldOperation({
        label: `bootstrap signature ${boundary}`,
        owner: () => p.f.sessions,
        progress: { kind: "controlled", clock: "external" },
      }, (hold) => {
        const sign = SignJWT.prototype.sign;
        SignJWT.prototype.sign = function (...args) {
          SignJWT.prototype.sign = sign;
          return hold().then(() => sign.apply(this, args));
        };
        try {
          return p.f.sessions.issue(proof);
        } finally {
          SignJWT.prototype.sign = sign;
        }
      }, async (operation) => {
        await operation.reached();
        if (boundary === "owner") p.owner.retire();
        if (boundary === "abort") p.abort.abort();
        if (boundary === "aggregate") p.f.accounts.retireCredentials();
        if (boundary === "account") {
          await resetFixturePassword(
            p.f.accounts,
            p.identity.id,
            "changed",
            NEXT,
          );
        }
        if (boundary === "acl") {
          p.acl.save({ everybody: "none", grants: {} }, p.acl.capture(), {
            updateId: NEXT,
            actorId: p.identity.id,
          });
        }
        if (boundary === "signing") {
          const raw = Deno.readTextFileSync(`${p.f.root}/sessions.json`);
          Deno.writeTextFileSync(`${p.f.root}/replacement`, raw);
          Deno.renameSync(
            `${p.f.root}/replacement`,
            `${p.f.root}/sessions.json`,
          );
        }
        await assertRejects(
          () => operation.result(),
          AuthenticationError,
          "Invalid authentication credentials.",
        );
        await assertRejects(
          () => p.f.sessions.issue(proof),
          AuthenticationError,
          "Invalid authentication credentials.",
        );
      });
    }));
}

Deno.test("bootstrap proof: actual first-file publication cannot mint before the ACL and runtime pair settle", () =>
  bootstrapPair(async (p) => {
    p.set.decide();
    const link = Deno.linkSync;
    const events: string[] = [];
    Deno.linkSync = (from, to) => {
      link(from, to);
      if (String(to) === `${p.f.root}/accounts.json`) {
        events.push("account linked");
        assertThrows(
          () => p.proof(),
          AuthenticationError,
          "Invalid authentication credentials.",
        );
      }
      if (String(to) === `${p.f.root}/vault/access.json`) {
        events.push("ACL linked");
      }
    };
    try {
      assertEquals(p.set.publish().state, "committed");
    } finally {
      Deno.linkSync = link;
    }
    assertEquals(events, ["account linked", "ACL linked"]);
    assertThrows(
      () => p.proof(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    p.set.release();
    const body = await receiveSession(await p.f.sessions.issue(p.proof()));
    assertEquals(body.principal.accountId, p.identity.id);
  }));

for (
  const boundary of [
    "owner",
    "aggregate",
    "account",
    "acl",
    "acl-binding",
    "signing",
    "cancel",
    "abort",
  ] as const
) {
  Deno.test(`bootstrap proof: queued body ${boundary} releases no token bytes`, () =>
    bootstrapPair(async (p) => {
      p.settle();
      const proof = p.proof();
      const issued = await p.f.sessions.issue(proof);
      if (boundary === "owner") p.owner.retire();
      if (boundary === "abort") p.abort.abort();
      if (boundary === "aggregate") p.f.accounts.retireCredentials();
      if (boundary === "account") {
        await resetFixturePassword(
          p.f.accounts,
          p.identity.id,
          "changed",
          NEXT,
        );
      }
      if (boundary === "acl") {
        p.acl.save({ everybody: "none", grants: {} }, p.acl.capture(), {
          updateId: NEXT,
          actorId: p.identity.id,
        });
      }
      if (boundary === "acl-binding") {
        const file = `${p.f.root}/vault/access.json`;
        const replacement = `${p.f.root}/vault/replacement`;
        const raw = Deno.readTextFileSync(file);
        Deno.writeTextFileSync(replacement, raw);
        Deno.renameSync(replacement, file);
        assertEquals(Deno.readTextFileSync(file), raw);
      }
      if (boundary === "signing") {
        const raw = Deno.readTextFileSync(`${p.f.root}/sessions.json`);
        Deno.writeTextFileSync(`${p.f.root}/replacement`, raw);
        Deno.renameSync(`${p.f.root}/replacement`, `${p.f.root}/sessions.json`);
      }
      if (boundary === "cancel") await issued.body.cancel();
      else {await assertRejects(
          () => receiveSession(issued),
          AuthenticationError,
          "Invalid authentication credentials.",
        );}
      await assertRejects(
        () => p.f.sessions.issue(proof),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    }));
}

Deno.test("setup enrollment: candidate retirement after transfer rejects decision without activating TOTP", () =>
  preparationFixture(async (f) => {
    const source = f.authority("initial");
    const abort = new AbortController();
    const bundle = await f.accounts.credentials.beginInitialEnrollment(
      source,
      "alice",
      abort.signal,
    );
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      source,
      {
        ...f.request(),
        authenticator: {
          key: bundle.key,
          code: await authenticatorCode(bundle.secret, SETUP_NOW),
        },
      },
    );
    const acl = withEnrolledSetupPair(f.accounts, prepared, (publication) => {
      abort.abort();
      assertThrows(
        () => publication.decide(),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      assertThrows(
        () => publication.publish(),
        PublicationSetUnavailable,
        UNAVAILABLE,
      );
    });
    assertEquals([
      f.accounts.capture().value.accounts,
      acl.grants,
      [...Deno.readDirSync(f.root)].map((entry) => entry.name),
      [...Deno.readDirSync(`${f.root}/vault`)],
    ], [[], {}, ["vault"], []]);
  }, setupOptions));

Deno.test("setup enrollment: a newer issuance retires already prepared confirmation before transfer", () =>
  preparationFixture(async (f) => {
    const source = f.authority("initial");
    const first = await f.accounts.credentials.beginInitialEnrollment(
      source,
      "alice",
    );
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      source,
      {
        ...f.request(),
        authenticator: {
          key: first.key,
          code: await authenticatorCode(first.secret, SETUP_NOW),
        },
      },
    );
    const current = await f.accounts.credentials.beginInitialEnrollment(
      source,
      "alice",
    );
    assertThrows(
      () =>
        f.accounts.credentials.prepareAccountParticipant(
          prepared.prepared,
          SET,
        ),
      StoredConfigConflict,
      CONFLICT,
    );
    assertEquals(f.accounts.capture().value.accounts, []);
    const accepted = await f.accounts.credentials.prepareInitialAccount(
      source,
      {
        ...f.request(),
        authenticator: {
          key: current.key,
          code: await authenticatorCode(current.secret, SETUP_NOW),
        },
      },
    );
    publishEnrolledSetup(f.accounts, accepted);
    assertEquals(storedState(f.accounts).accounts[0].totpKey, current.key);
  }, setupOptions));

for (
  const bad of [
    "unissued",
    "retired",
    "login",
    "authority",
    "code",
    "wrong-purpose",
  ] as const
) {
  Deno.test(`setup enrollment: ${bad} confirmation rejects before hashing or active changes`, () => {
    let hashes = 0;
    return preparationFixture(async (f) => {
      const authority = f.authority("initial");
      const bundle = await f.accounts.credentials.beginInitialEnrollment(
        authority,
        "alice",
      );
      const code = await authenticatorCode(bundle.secret, SETUP_NOW);
      if (bad === "retired") {
        await f.accounts.credentials.beginInitialEnrollment(authority, "alice");
      }
      const source = bad === "authority"
        ? f.authority("initial")
        : bad === "wrong-purpose"
        ? f.authority("recipient")
        : authority;
      const before = f.accounts.capture();
      await assertRejects(
        () =>
          f.accounts.credentials.prepareInitialAccount(source, {
            ...f.request({ login: bad === "login" ? "bob" : "alice" }),
            authenticator: {
              key: bad === "unissued" ? "A".repeat(32) : bundle.key,
              code: bad === "code" ? "bad-code" : code,
            },
          }),
        IdentityStateError,
        INVALID,
      );
      assertEquals(hashes, 0);
      assertStrictEquals(f.accounts.capture(), before);
      assertEquals([...Deno.readDirSync(f.root)], []);
    }, {
      ...setupOptions,
      hash: (password) => {
        hashes++;
        return Promise.resolve(fixturePasswordHash(password));
      },
    });
  });
}

Deno.test("setup enrollment: forged, cloned, foreign and recipient authorities cannot issue candidates", () =>
  preparationFixture(async (f) => {
    const authority = f.authority("initial");
    for (
      const source of [
        {},
        { ...authority },
        structuredClone(authority),
        f.authority("recipient"),
        null,
      ]
    ) {
      await assertRejects(
        () =>
          f.accounts.credentials.beginInitialEnrollment(
            source as AccountPreparationAuthority,
            "alice",
          ),
        IdentityStateError,
        INVALID,
      );
    }
    await preparationFixture(async (other) => {
      await assertRejects(
        () =>
          other.accounts.credentials.beginInitialEnrollment(authority, "alice"),
        IdentityStateError,
        INVALID,
      );
    }, setupOptions);
    const candidate = await f.accounts.credentials.beginInitialEnrollment(
      authority,
      "alice",
    );
    assertEquals(candidate.key.length, 32);
    await f.createInitial();
    await assertRejects(
      () => f.accounts.credentials.beginInitialEnrollment(authority, "alice"),
      StoredConfigConflict,
      CONFLICT,
    );
  }, setupOptions));

for (
  const boundary of ["replacement", "abort", "authority", "aggregate"] as const
) {
  Deno.test(`setup enrollment: held QR ${boundary} cannot publish a stale candidate`, () => {
    let renderHold: (() => Promise<void>) | undefined;
    let renders = 0;
    return preparationFixture(async (f) => {
      const source = f.authority("initial");
      const abort = new AbortController();
      await heldOperation({
        label: `initial QR ${boundary}`,
        owner: () => f.accounts,
        progress: { kind: "controlled", clock: "external" },
      }, (hold) => {
        renderHold = hold;
        return f.accounts.credentials.beginInitialEnrollment(
          source,
          "alice",
          abort.signal,
        );
      }, async (operation) => {
        await operation.reached();
        let replacement:
          | Awaited<
            ReturnType<typeof f.accounts.credentials.beginInitialEnrollment>
          >
          | undefined;
        if (boundary === "replacement") {
          replacement = await f.accounts.credentials.beginInitialEnrollment(
            source,
            "bob",
          );
        }
        if (boundary === "abort") abort.abort();
        if (boundary === "authority") f.retire();
        if (boundary === "aggregate") f.accounts.retireCredentials();
        if (boundary === "abort") {
          await assertRejects(
            () => operation.result(),
            AuthenticationError,
            "Invalid authentication credentials.",
          );
        } else {
          await assertRejects(
            () => operation.result(),
            OwnershipError,
            "Owner is retired",
          );
        }
        assertEquals(f.accounts.capture().value.accounts, []);
        if (replacement) {
          const prepared = await f.accounts.credentials.prepareInitialAccount(
            source,
            {
              ...f.request({ login: "bob" }),
              authenticator: {
                key: replacement.key,
                code: await authenticatorCode(replacement.secret, SETUP_NOW),
              },
            },
          );
          publishEnrolledSetup(f.accounts, prepared);
          assertEquals(f.accounts.byLogin("bob"), prepared.identity);
        }
      });
    }, {
      ...setupOptions,
      renderQr: async (uri) => {
        if (++renders === 1) await renderHold!();
        return `qr:${uri}`;
      },
    });
  });
}

for (
  const boundary of ["replacement", "abort", "authority", "aggregate"] as const
) {
  Deno.test(`setup enrollment: held hash ${boundary} cannot install a stale secret`, () => {
    let hashHold: (() => Promise<void>) | undefined;
    return preparationFixture(async (f) => {
      const source = f.authority("initial");
      const bundle = await f.accounts.credentials.beginInitialEnrollment(
        source,
        "alice",
      );
      const code = await authenticatorCode(bundle.secret, SETUP_NOW);
      const abort = new AbortController();
      await heldOperation({
        label: `initial hash ${boundary}`,
        owner: () => f.accounts,
        progress: { kind: "controlled", clock: "external" },
      }, (hold) => {
        hashHold = hold;
        return f.accounts.credentials.prepareInitialAccount(source, {
          ...f.request(),
          authenticator: { key: bundle.key, code },
        }, abort.signal);
      }, async (operation) => {
        await operation.reached();
        if (boundary === "replacement") {
          await f.accounts.credentials.beginInitialEnrollment(source, "alice");
        }
        if (boundary === "abort") abort.abort();
        if (boundary === "authority") f.retire();
        if (boundary === "aggregate") f.accounts.retireCredentials();
        if (boundary === "replacement") {
          await assertRejects(
            () => operation.result(),
            StoredConfigConflict,
            CONFLICT,
          );
        } else if (boundary === "abort") {
          await assertRejects(
            () => operation.result(),
            AuthenticationError,
            "Invalid authentication credentials.",
          );
        } else {await assertRejects(
            () => operation.result(),
            OwnershipError,
            "Owner is retired",
          );}
        assertEquals([f.accounts.capture().value.accounts, [
          ...Deno.readDirSync(f.root),
        ]], [[], []]);
      });
    }, {
      ...setupOptions,
      hash: async (password) => {
        await hashHold!();
        return fixturePasswordHash(password);
      },
    });
  });
}

Deno.test("setup enrollment: prepared confirmed step survives clock movement and decided pair replay without a candidate", () => {
  let now = SETUP_NOW;
  return preparationFixture(async (f) => {
    const source = f.authority("initial");
    const bundle = await f.accounts.credentials.beginInitialEnrollment(
      source,
      "alice",
    );
    const code = await authenticatorCode(bundle.secret, now);
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      source,
      { ...f.request(), authenticator: { key: bundle.key, code } },
    );
    const acl = new AclRepository(`${f.root}/vault`, VAULT_A, {
      accounts: f.accounts,
    });
    acl.prepareParents();
    const lifetime = createOperationLease("live", [() => undefined]);
    const access = acl.prepareInitialParticipant(
      prepared.identity,
      "edit",
      acl.capture(),
      lifetime.lease,
      SET,
    );
    const journal = journalPath(f.root);
    let account: PublicationParticipant | undefined;
    let set: ReturnType<typeof createPublicationSet> | undefined;
    try {
      account = f.accounts.credentials.prepareAccountParticipant(
        prepared.prepared,
        SET,
      );
      const publication = set = createPublicationSet(
        SET,
        [account, access],
        journal,
      );
      now += 3_000_000;
      publication.decide();
      Deno.writeTextFileSync(
        journal,
        JSON.stringify({
          setId: SET,
          phase: "decided",
          records: publication.records,
        }),
      );
      assertEquals(publication.publish().state, "committed");
      assertThrows(
        () => publication.release(),
        PublicationSetUnavailable,
        UNAVAILABLE,
      );
      const before = [
        Deno.readTextFileSync(`${f.root}/accounts.json`),
        Deno.readTextFileSync(`${f.root}/vault/access.json`),
      ];
      f.accounts.retireCredentials();
      const recovery = f.offline();
      try {
        const reopened = new AccountRepository(f.root, undefined, {
          now: () => SETUP_NOW,
        });
        const reopenedAcl = new AclRepository(`${f.root}/vault`, VAULT_A, {
          accounts: reopened,
        });
        const aclPart = reopenedAcl.recoverParticipant(
          publication.records[1],
          recovery.authority,
          SET,
          "decided",
        );
        assertMissingPeer(f.root, [aclPart]);
        for (const invalid of [{}, { ...aclPart }, access]) {
          assertThrows(
            () =>
              reopened.recoverParticipant(
                publication.records[0],
                recovery.authority,
                SET,
                "decided",
                invalid as PublicationParticipant,
              ),
            IdentityStateError,
            INVALID,
          );
        }
        const accountPart = reopened.recoverParticipant(
          publication.records[0],
          recovery.authority,
          SET,
          "decided",
          aclPart,
        );
        assertMissingPeer(f.root, [accountPart]);
        const replay = createPublicationSet(
          SET,
          [accountPart, aclPart],
          journal,
        );
        replay.decide();
        assertEquals(replay.publish().state, "committed");
        Deno.removeSync(journal);
        assertEquals(replay.release().state, "committed");
        assertEquals([
          Deno.readTextFileSync(`${f.root}/accounts.json`),
          Deno.readTextFileSync(`${f.root}/vault/access.json`),
        ], before);
        assertEquals(
          storedState(reopened).accounts.map((
            a,
          ) => [a.totpKey, a.totpKeyEncoding, a.lastTotpStep]),
          [[bundle.key, "base32", SETUP_NOW / 30_000]],
        );
        await assertRejects(
          () => reopened.credentials.authenticate("alice", "password", code),
          AuthenticationError,
          "Invalid authentication credentials.",
        );
        assertEquals(reopenedAcl.capture().value.everybody, "edit");
      } finally {
        recovery.close();
      }
      now = SETUP_NOW + 30_000;
      const restarted = new AccountRepository(f.root, undefined, {
        now: () => now,
      });
      await restarted.credentials.authenticate(
        "alice",
        "password",
        await authenticatorCode(bundle.secret, now),
      );
      assertEquals(
        storedState(restarted).accounts[0].lastTotpStep,
        now / 30_000,
      );
    } finally {
      set?.discard();
      account?.discard();
      access.discard();
      lifetime.retire();
    }
  }, { ...setupOptions, now: () => now });
});

for (const login of [" Alice ", "surrogate\ud800", "colon:name@example.home"]) {
  Deno.test(`setup enrollment: current server-issued candidate persists its exact interpretation and accepted step (${JSON.stringify(login)})`, () =>
    preparationFixture(async (f) => {
      const authority = f.authority("initial");
      const before = f.accounts.capture();
      const bundle = await f.accounts.credentials.beginInitialEnrollment(
        authority,
        login,
      );
      assertEquals(Object.keys(bundle).sort(), ["key", "qr", "secret", "uri"]);
      assertEquals([bundle.key, bundle.qr], [
        bundle.secret,
        `qr:${bundle.uri}`,
      ]);
      assertStrictEquals(f.accounts.capture(), before);
      assertEquals([...Deno.readDirSync(f.root)], []);
      const code = await authenticatorCode(bundle.secret, SETUP_NOW);
      const prepared = await f.accounts.credentials.prepareInitialAccount(
        authority,
        {
          ...f.request({ login }),
          authenticator: { key: bundle.key, code },
        },
      );
      assertEquals([
        prepared.identity.totpEnabled,
        prepared.identity.passwordChangeRequired,
      ], [true, false]);
      assertStrictEquals(f.accounts.capture(), before);
      assertThrows(
        () => f.accounts.credentials.publishPreparedAccount(prepared.prepared),
        IdentityStateError,
        INVALID,
      );
      assertStrictEquals(f.accounts.capture(), before);
      publishEnrolledSetup(f.accounts, prepared);
      const stored = storedState(f.accounts);
      assertEquals(
        stored.accounts.map((a) => ({
          login: a.login,
          totpKey: a.totpKey,
          totpKeyEncoding: a.totpKeyEncoding,
          lastTotpStep: a.lastTotpStep,
          restricted: a.passwordChangeRequired,
        })),
        [{
          login: login.trim().toLowerCase(),
          totpKey: bundle.key,
          totpKeyEncoding: "base32",
          lastTotpStep: SETUP_NOW / 30_000,
          restricted: false,
        }],
      );
      const reopened = new AccountRepository(f.root, undefined, {
        now: () => SETUP_NOW,
      });
      await assertRejects(
        () => reopened.credentials.authenticate(login, "password", undefined),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      await assertRejects(
        () => reopened.credentials.authenticate(login, "password", code),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
    }, setupOptions));
}
