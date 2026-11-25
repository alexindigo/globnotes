// SPDX-License-Identifier: LGPL-3.0-only
import { createOwnedPublication as reservationFixtureOwner } from "../server/config/owned_publication.ts";
import { StoredConfigConflict as ReservationConflict } from "../server/config/publication_outcome.ts";
import { assertStrictEquals as assertRejectedIdentity } from "@std/assert";
import { join } from "@std/path";

function prepareReservationJournal(root: string, setId: string) {
  const lifetime = createOperationLease("live", [() => undefined], []);
  try {
    const journal = join(root, "journal.json");
    const original = createPublicationSet(
      setId,
      ["first", "second"].map((role, i) => {
        const target = reservationFixtureOwner<number>(
          join(root, `${role}.json`),
          () => undefined,
          () => undefined,
          root,
        );
        return target.prepareParticipant(
          i + 1,
          target.capture(),
          lifetime.lease,
          setId,
          role,
        );
      }),
      journal,
    );
    original.decide();
    Deno.writeTextFileSync(journal, JSON.stringify(original.records));
    assertEquals(original.publish().state, "committed");
    return original;
  } finally {
    lifetime.retire();
  }
}

for (
  const [failure, withUnrelatedHold] of [
    ["none", true],
    ["validation", true],
    ["validation", false],
    ["byte mismatch", true],
    ["byte mismatch", false],
    ["publication", true],
    ["journal retirement", true],
  ] as const
) {
  const holdLabel = withUnrelatedHold ? "" : " without an unrelated hold";
  Deno.test(`publication reservation custody after recovery outcome: ${failure}${holdLabel}`, () => {
    const root = Deno.makeTempDirSync();
    const lifetime = createOperationLease("live", [() => undefined], []);
    const { lease } = lifetime;
    const unavailable = new PublicationSetUnavailable().message;
    try {
      const setId = crypto.randomUUID();
      const roles = ["first", "second"];
      const paths = roles.map((role) => join(root, `${role}.json`));
      const journal = join(root, "journal.json");
      const owner = (
        path: string,
        install: (value: number) => undefined = () => undefined,
      ) => reservationFixtureOwner(path, install, () => undefined, root);
      const ordinary = paths.map((path) => owner(path));
      const write = (target: typeof ordinary[number], value: number) =>
        target.prepare(value, target.capture(), lease).publish().state;
      const verifyFenced = () => {
        for (const target of ordinary) {
          assertThrows(
            () => write(target, 3),
            PublicationSetUnavailable,
            unavailable,
          );
        }
      };

      // A same-target hold must survive settlement, but admission failures
      // also run without it so recovery alone must fence both targets.
      const unrelated = withUnrelatedHold ? owner(paths[0]) : undefined;
      const unrelatedHandle = unrelated?.prepareParticipant(
        4,
        unrelated.capture(),
        lease,
        crypto.randomUUID(),
        roles[0],
      );

      const original = prepareReservationJournal(root, setId);
      const admissionFailure = failure === "validation" ||
        failure === "byte mismatch";
      if (admissionFailure) {
        // Model a restart after installation: keep the journal and bytes but
        // remove the original set's in-process reservations before recovery.
        const savedJournal = `${journal}.saved`;
        Deno.renameSync(journal, savedJournal);
        assertEquals(original.release().state, "committed");
        Deno.renameSync(savedJournal, journal);
      }

      const recovery = acquireOfflineRecovery(root);
      try {
        const durable: unknown[] = JSON.parse(Deno.readTextFileSync(journal));
        const installed: number[] = [];
        let failInstall = failure === "publication";
        const recover = (
          i: number,
          validate = (value: unknown) => value as number,
        ) =>
          owner(paths[i], (value) => {
            if (failInstall && i === 1) throw new Error("Installation failed");
            installed.push(value);
            return undefined;
          }).recoverParticipant(
            durable[i],
            recovery.authority,
            setId,
            roles[i],
            validate,
            "decided",
          );
        const reconstruct = () => {
          const members = [recover(0), recover(1)];
          if (failure === "none") {
            assertThrows(
              () => createPublicationSet(setId, members.slice(0, 1), journal),
              ReservationConflict,
              new ReservationConflict().message,
            );
          }
          return createPublicationSet(setId, members, journal);
        };
        if (admissionFailure) {
          const first = recover(0);
          try {
            if (failure === "validation") {
              const rejected = new Error("Rejected recorded value");
              assertRejectedIdentity(
                assertThrows(
                  () =>
                    recover(1, () => {
                      throw rejected;
                    }),
                  Error,
                  rejected.message,
                ),
                rejected,
              );
            } else {
              assertThrows(
                () => recover(1, () => 19),
                ReservationConflict,
                new ReservationConflict().message,
              );
            }
          } finally {
            first.discard();
          }
          verifyFenced();
        }
        if (failure === "publication" || failure === "journal retirement") {
          const firstReplay = reconstruct();
          firstReplay.decide();
          assertEquals(
            firstReplay.publish().state,
            failInstall ? "recovery-required" : "committed",
          );
          if (!failInstall) {
            assertThrows(
              () => firstReplay.release(),
              PublicationSetUnavailable,
              unavailable,
            );
          }
          verifyFenced();
          failInstall = false;
        }

        const replay = reconstruct();
        replay.decide();
        assertEquals(replay.publish().state, "committed");
        assertEquals(
          installed,
          failure === "publication"
            ? [1, 1, 2]
            : failure === "journal retirement"
            ? [1, 2, 1, 2]
            : [1, 2],
        );
        verifyFenced();
        Deno.removeSync(journal);
        if (failure === "none") {
          assertThrows(
            () => original.release(),
            PublicationSetUnavailable,
            unavailable,
          );
        }
        assertEquals(replay.release().state, "committed");
        if (unrelatedHandle) {
          assertThrows(
            () => write(ordinary[0], 3),
            PublicationSetUnavailable,
            unavailable,
          );
          unrelatedHandle.discard();
        }
        assertEquals(ordinary.map((target) => write(target, 3)), [
          "committed",
          "committed",
        ]);
        assertEquals(paths.map((path) => Deno.readTextFileSync(path)), [
          "3\n",
          "3\n",
        ]);
      } finally {
        recovery.close();
      }
    } finally {
      lifetime.retire();
      Deno.removeSync(root, { recursive: true });
    }
  });
}
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { acquireOfflineRecovery } from "../server/auth/offline_recovery.ts";
import { IdentityFile } from "../server/auth/records.ts";
import {
  BoundFileStore,
  syncStoredDirectory,
} from "../server/config/file_store.ts";
import {
  createOperationLease,
  type OperationLease,
} from "../server/operation_lease.ts";
import {
  createOwnedPublication,
  createPublicationSet,
  type PublicationParticipant,
} from "../server/config/owned_publication.ts";
import {
  PublicationSetUnavailable,
  StoredConfigConflict,
} from "../server/config/publication_outcome.ts";
import type { RecordedCandidateData } from "../server/config/internal/publication_port.ts";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import { spawnOwnedChild } from "./helpers/owned_child.ts";
import { DENO } from "./helpers/process_values.ts";
import {
  objectRecordSchema,
  openRecordDirectory,
  recordReader,
} from "./helpers/owned_record_channel.ts";

const SET = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const unavailable =
  "Publication set is unavailable; settlement or recovery is required.";
const conflict = "Stored configuration changed before commit.";
const journalPath = (root: string) => `${root}/journal.json`;
function retireJournal(root: string) {
  Deno.removeSync(journalPath(root));
  syncStoredDirectory(root);
}
function fixture(
  run: (root: string, scope: FixtureScope) => void | Promise<void>,
) {
  return fixtureScope(async (scope) => {
    const root = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "publication-set-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    await scope.admit(() => run(root.value, scope));
  });
}
const validateRevision = (value: unknown) => {
  if (
    !value || typeof value !== "object" ||
    Object.keys(value).join() !== "revision" ||
    !Number.isSafeInteger((value as { revision: number }).revision)
  ) throw new Error("invalid revision");
  return value as { revision: number };
};
function pair(root: string, events: unknown[] = []) {
  const one = new IdentityFile(`${root}/one.json`, validateRevision, {
    revision: 0,
  }, () => {
    events.push(["one", one.capture().value, two.capture().value]);
    return undefined;
  });
  const two = new IdentityFile(`${root}/two.json`, validateRevision, {
    revision: 0,
  }, () => {
    events.push(["two", one.capture().value, two.capture().value]);
    return undefined;
  });
  return { one, two };
}
function ownParticipant(scope: FixtureScope, part: PublicationParticipant) {
  scope.defer(() => part.discard());
  return part;
}
function preparePair(
  scope: FixtureScope,
  { one, two }: ReturnType<typeof pair>,
  oneLease: OperationLease<"live">,
  twoLease = oneLease,
) {
  return [
    ownParticipant(
      scope,
      one.prepareParticipant(
        { revision: 1 },
        one.capture(),
        oneLease,
        SET,
        "one",
      ),
    ),
    ownParticipant(
      scope,
      two.prepareParticipant(
        { revision: 2 },
        two.capture(),
        twoLease,
        SET,
        "two",
      ),
    ),
  ];
}
function recoverSet(
  root: string,
  scope: FixtureScope,
  files: readonly ReturnType<typeof pair>["one"][],
  records: readonly RecordedCandidateData[],
  authority: object,
  phase: "prepared" | "decided",
) {
  const set = createPublicationSet(
    SET,
    files.map((file, i) =>
      ownParticipant(
        scope,
        file.recoverParticipant(
          records[i],
          authority,
          SET,
          i === 0 ? "one" : "two",
          phase,
        ),
      )
    ),
    journalPath(root),
  );
  scope.defer(() => set.discard());
  return set;
}
function stagedPair(root: string, scope: FixtureScope, events: unknown[] = []) {
  const { one, two } = pair(root, events);
  const lease = createOperationLease("live", [() => undefined]);
  scope.defer(() => lease.retire());
  const parts = preparePair(scope, { one, two }, lease.lease);
  const set = createPublicationSet(SET, parts, journalPath(root));
  scope.defer(() => set.discard());
  return { one, two, parts, set };
}

Deno.test("publication participant: acquisition fences reads before set assembly and standalone discard restores admission", () =>
  fixture((root, scope) => {
    const file = new IdentityFile(`${root}/one.json`, validateRevision, {
      revision: 0,
    });
    const before = file.capture();
    const lease = createOperationLease("live", [() => undefined]);
    scope.defer(() => lease.retire());
    const part = file.prepareParticipant(
      { revision: 1 },
      before,
      lease.lease,
      SET,
      "one",
    );
    scope.defer(() => part.discard());
    assertEquals(Object.keys(part), ["discard"]);
    assertThrows(() => file.capture(), PublicationSetUnavailable, unavailable);
    assertThrows(
      () => file.assertUnchanged(before),
      PublicationSetUnavailable,
      unavailable,
    );
    part.discard();
    assertStrictEquals(file.capture(), before);
    assertThrows(
      () => createPublicationSet(SET, [part], journalPath(root)),
      PublicationSetUnavailable,
      unavailable,
    );
    assertEquals([...Deno.readDirSync(root)], []);
  }));

for (const writer of ["same owner", "alias owner"] as const) {
  Deno.test(`publication participant: final ordinary write from ${writer} refuses a reservation acquired by its witness`, () =>
    fixture((root, scope) => {
      const target = `${root}/one.json`;
      const filename = writer === "same owner" ? target : `${root}/alias.json`;
      if (writer === "alias owner") {
        Deno.writeTextFileSync(target, '{"revision":0}\n');
        Deno.symlinkSync(target, filename);
      }
      const observed: string[] = [];
      const owner = (filename: string) =>
        createOwnedPublication<{ revision: number }>(filename, () => {
          observed.push("installed");
          return undefined;
        }, () => {
          observed.push("notified");
          return undefined;
        });
      const file = owner(target);
      const ordinary = writer === "same owner" ? file : owner(filename);
      const before = file.capture();
      const authority = createOperationLease("live", [() => undefined]);
      scope.defer(() => authority.retire());
      let reserve = false;
      let part: PublicationParticipant | undefined;
      const writerLease = createOperationLease("live", [() => {
        if (reserve && !part) {
          const acquired = file.prepareParticipant(
            { revision: 1 },
            before,
            authority.lease,
            SET,
            "one",
          );
          scope.defer(() => acquired.discard());
          part = acquired;
          observed.push("reserved");
        }
        return undefined;
      }]);
      scope.defer(() => writerLease.retire());
      const pending = ordinary.prepare(
        { revision: 9 },
        ordinary.capture(),
        writerLease.lease,
      );
      scope.defer(() => pending.discard());

      reserve = true;
      assertThrows(
        () => pending.publish(),
        PublicationSetUnavailable,
        unavailable,
      );
      const legacy = new BoundFileStore(filename);
      assertThrows(
        () => legacy.replace('{"revision":8}\n'),
        PublicationSetUnavailable,
        unavailable,
      );
      assertEquals([legacy.capture().raw, observed], [before.raw, [
        "reserved",
      ]]);

      part!.discard();
      assertEquals(
        ordinary.prepare({ revision: 2 }, ordinary.capture(), authority.lease)
          .publish().state,
        "committed",
      );
      assertEquals([Deno.readTextFileSync(target), observed], [
        '{"revision":2}\n',
        ["reserved", "installed", "notified"],
      ]);
      assertEquals(
        [...Deno.readDirSync(root)].map((e) => e.name).sort(),
        writer === "same owner" ? ["one.json"] : ["alias.json", "one.json"],
      );
    }));
}

Deno.test("publication set: committed alias warning is separate and next ordinary mutation retries cleanup without republication", () =>
  fixture((root, scope) => {
    const { one, two, set, parts } = stagedPair(root, scope);
    set.decide();
    const remove = Deno.removeSync;
    try {
      Deno.removeSync = () => {
        throw new Error("alias cleanup unavailable");
      };
      const result = set.publish();
      assertEquals([result.committed, result.state, result.warning], [
        true,
        "committed",
        "stored-durability-unconfirmed",
      ]);
    } finally {
      Deno.removeSync = remove;
    }
    assertEquals(set.release().state, "committed");
    assertThrows(
      () => createPublicationSet(SET, parts, journalPath(root)),
      TypeError,
      "Publication set requires unused issued participants.",
    );
    one.commit({ revision: 3 });
    two.commit({ revision: 4 });
    assertEquals([
      one.capture().value,
      two.capture().value,
      [...Deno.readDirSync(root)].map((e) => e.name).sort(),
    ], [{ revision: 3 }, { revision: 4 }, ["one.json", "two.json"]]);
  }));

Deno.test("publication participant: configured participant roots are bound before recovery, never selected by journal data", () =>
  fixture((root, scope) => {
    Deno.mkdirSync(`${root}/vault`);
    const one = new IdentityFile(
      `${root}/one.json`,
      validateRevision,
      { revision: 0 },
      undefined,
      root,
    );
    const two = new IdentityFile(
      `${root}/vault/two.json`,
      validateRevision,
      { revision: 0 },
      undefined,
      root,
    );
    const lease = createOperationLease("live", [() => undefined]);
    scope.defer(() => lease.retire());
    const set = createPublicationSet(
      SET,
      preparePair(scope, { one, two }, lease.lease),
      journalPath(root),
    );
    scope.defer(() => set.discard());
    set.decide();
    set.publish();
    set.release();
    const recovery = acquireOfflineRecovery(root);
    scope.defer(() => recovery.close());
    const files = [
      new IdentityFile(
        `${root}/one.json`,
        validateRevision,
        { revision: 0 },
        undefined,
        root,
      ),
      new IdentityFile(
        `${root}/vault/two.json`,
        validateRevision,
        { revision: 0 },
        undefined,
        root,
      ),
    ];
    const replay = recoverSet(
      root,
      scope,
      files,
      set.records,
      recovery.authority,
      "decided",
    );
    replay.decide();
    assertEquals(replay.publish().state, "committed");
    replay.release();
    assertEquals(
      files.map((file) => file.capture().persistence),
      set.records.map((r) => r.after),
    );
    const foreignRoot = `${root}/other-owner`;
    const foreign = acquireOfflineRecovery(foreignRoot);
    scope.defer(() => foreign.close());
    const rebound = new IdentityFile(
      `${root}/one.json`,
      validateRevision,
      { revision: 0 },
      undefined,
      foreignRoot,
    );
    assertEquals(set.records.map((record) => record.root), [root, root]);
    assertThrows(
      () =>
        rebound.recoverParticipant(
          set.records[0],
          foreign.authority,
          SET,
          "one",
          "decided",
        ),
      StoredConfigConflict,
      conflict,
    );
  }));

Deno.test("publication set: every repository read/write is fenced through installation; notify sees only complete runtime state", () =>
  fixture((root, scope) => {
    const events: unknown[] = [];
    const { one, two, parts, set } = stagedPair(root, scope, events);
    const link = Deno.linkSync;
    const inspect = (phase: string) => {
      for (const file of [one, two]) {
        assertThrows(
          () => file.capture(),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => file.assertUnchanged(),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => file.prepareParents(),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => file.commit({ revision: 9 }),
          PublicationSetUnavailable,
          unavailable,
        );
      }
      events.push(phase);
    };
    set.validate();
    inspect("prepared");
    assertEquals(set.records.map((r) => [r.before.raw, r.after.raw]), [[
      null,
      '{"revision":1}\n',
    ], [null, '{"revision":2}\n']]);
    set.decide();
    set.discard();
    for (const part of parts) part.discard();
    try {
      Deno.linkSync = (from, to) => {
        link(from, to);
        inspect(
          String(to).endsWith("one.json") ? "published-one" : "published-two",
        );
      };
      const result = set.publish();
      assertEquals([
        result.committed,
        result.state,
        result.warning,
        result.notificationFailed,
      ], [true, "committed", null, false]);
    } finally {
      Deno.linkSync = link;
    }
    inspect("installed");
    const result = set.release();
    assertEquals([result.state, result.notificationFailed], [
      "committed",
      false,
    ]);
    assertEquals(events, [
      "prepared",
      "published-one",
      "published-two",
      "installed",
      ["one", { revision: 1 }, { revision: 2 }],
      ["two", { revision: 1 }, { revision: 2 }],
    ]);
    assertEquals(
      [one.capture().persistence, two.capture().persistence],
      set.records.map((r) => r.after),
    );
    assertThrows(() => set.release(), PublicationSetUnavailable, unavailable);
  }));

for (
  const kind of [
    "forged",
    "cloned",
    "duplicate",
    "foreign-set",
    "non-array",
  ] as const
) {
  Deno.test(`publication set: ${kind} participants cannot acquire publication authority`, () =>
    fixture((root, scope) => {
      const one = new IdentityFile(`${root}/one.json`, validateRevision, {
        revision: 0,
      });
      const lease = createOperationLease("live", [() => undefined]);
      scope.defer(() => lease.retire());
      const part = one.prepareParticipant(
        { revision: 1 },
        one.capture(),
        lease.lease,
        SET,
        "one",
      );
      scope.defer(() => part.discard());
      const input = kind === "forged"
        ? [{}]
        : kind === "cloned"
        ? [{ ...part }]
        : kind === "duplicate"
        ? [part, part]
        : kind === "non-array"
        ? { map: () => [] }
        : [part];
      const type = kind === "duplicate" || kind === "foreign-set"
        ? StoredConfigConflict
        : TypeError;
      const message = kind === "non-array"
        ? "Publication set requires an array."
        : type === TypeError
        ? "Publication set requires unused issued participants."
        : conflict;
      assertThrows(
        () =>
          createPublicationSet(
            kind === "foreign-set" ? OTHER : SET,
            input as PublicationParticipant[],
            journalPath(root),
          ),
        type,
        message,
      );
      part.discard();
      assertEquals([one.capture().value, one.capture().persistence.raw], [{
        revision: 0,
      }, null]);
    }));
}

Deno.test("publication set: undecided cleanup attempts every member, rejects reads until cleanup retry and cannot later decide", () =>
  fixture((root, scope) => {
    const { one, two, set } = stagedPair(root, scope);
    const remove = Deno.removeSync,
      primary = new Error("first cleanup"),
      calls: string[] = [];
    try {
      Deno.removeSync = (file, options) => {
        calls.push(String(file));
        if (calls.length === 1) throw primary;
        remove(file, options);
      };
      const error = assertThrows(
        () => set.discard(),
        AggregateError,
        "Publication set cleanup failed.",
      );
      assertEquals(error.errors, [primary]);
      assertStrictEquals(error.errors[0], primary);
    } finally {
      Deno.removeSync = remove;
    }
    assertEquals(calls, set.records.map((r) => `${root}/${r.candidate}`));
    assertThrows(() => one.capture(), PublicationSetUnavailable, unavailable);
    assertThrows(() => set.decide(), PublicationSetUnavailable, unavailable);
    set.discard();
    assertEquals([one.capture().value, two.capture().value, [
      ...Deno.readDirSync(root),
    ]], [{ revision: 0 }, { revision: 0 }, []]);
  }));

for (const boundary of ["install", "retire-journal"] as const) {
  Deno.test(`publication set: required ${boundary} failure keeps both participants unavailable`, () =>
    fixture((root, scope) => {
      const { one, two, set } = stagedPair(root, scope);
      const journal = new IdentityFile(
        `${root}/journal.json`,
        (value) => value,
        null,
      );
      set.decide();
      journal.commit({ setId: SET, phase: "decided", records: set.records });
      const freeze = Object.freeze;
      try {
        if (boundary === "install") {
          Object.freeze = ((value: unknown) => {
            if (
              (value as { value?: { revision?: number } })?.value?.revision ===
                2
            ) throw new Error("install failure");
            return freeze(value);
          }) as typeof freeze;
        }
        assertEquals(
          set.publish().state,
          boundary === "install" ? "recovery-required" : "committed",
        );
      } finally {
        Object.freeze = freeze;
      }
      if (boundary === "retire-journal") {
        const remove = Deno.removeSync,
          failure = new Error("journal retirement failed");
        try {
          Deno.removeSync = () => {
            throw failure;
          };
          assertStrictEquals(
            assertThrows(
              () => retireJournal(root),
              Error,
              failure.message,
            ),
            failure,
          );
        } finally {
          Deno.removeSync = remove;
        }
        assertEquals(
          JSON.parse(Deno.readTextFileSync(`${root}/journal.json`)),
          { setId: SET, phase: "decided", records: set.records },
        );
      }
      set.discard();
      for (const file of [one, two]) {
        assertThrows(
          () => file.capture(),
          PublicationSetUnavailable,
          unavailable,
        );
        assertThrows(
          () => file.commit({ revision: 99 }),
          PublicationSetUnavailable,
          unavailable,
        );
      }
      assertThrows(
        () => set.release(),
        PublicationSetUnavailable,
        unavailable,
      );
      assertEquals([
        Deno.readTextFileSync(`${root}/one.json`),
        Deno.readTextFileSync(`${root}/two.json`),
      ], ['{"revision":1}\n', '{"revision":2}\n']);
      const recovery = acquireOfflineRecovery(root);
      scope.defer(() => recovery.close());
      const fresh = pair(root);
      const replay = recoverSet(
        root,
        scope,
        [fresh.one, fresh.two],
        set.records,
        recovery.authority,
        "decided",
      );
      replay.decide();
      assertEquals(replay.publish().state, "committed");
      retireJournal(root);
      replay.release();
      assertEquals([fresh.one.capture().value, fresh.two.capture().value], [{
        revision: 1,
      }, { revision: 2 }]);
    }));
}

Deno.test("publication set: all observers are attempted and notification failure cannot undo publication", () =>
  fixture((root, scope) => {
    const events: unknown[] = [];
    const one = new IdentityFile(`${root}/one.json`, validateRevision, {
      revision: 0,
    }, () => {
      events.push("one");
      throw new Error("observer failure");
    });
    const two = new IdentityFile(`${root}/two.json`, validateRevision, {
      revision: 0,
    }, () => {
      events.push(["two", one.capture().value, two.capture().value]);
      return undefined;
    });
    const lease = createOperationLease("live", [() => undefined]);
    scope.defer(() => lease.retire());
    const set = createPublicationSet(
      SET,
      preparePair(scope, { one, two }, lease.lease),
      journalPath(root),
    );
    scope.defer(() => set.discard());
    set.decide();
    set.publish();
    const result = set.release();
    assertEquals([result.state, result.warning, result.notificationFailed], [
      "committed",
      null,
      true,
    ]);
    assertEquals(events, ["one", ["two", { revision: 1 }, { revision: 2 }]]);
  }));

for (
  const boundary of ["first-candidate", "second-candidate", "journal"] as const
) {
  Deno.test(`publication set: undecided ${boundary} failure preserves both files and releases all creating custody`, () =>
    fixture((root, scope) => {
      const { one, two } = pair(root);
      const before = [one.capture(), two.capture()];
      const lease = createOperationLease("live", [() => undefined]);
      scope.defer(() => lease.retire());
      const parts: PublicationParticipant[] = [];
      const write = Deno.writeTextFileSync, primary = new Error(boundary);
      let set: ReturnType<typeof createPublicationSet> | undefined;
      try {
        Deno.writeTextFileSync = (file, data, options) => {
          if (
            typeof data === "string" && (
              boundary === "first-candidate" && data === '{"revision":1}\n' ||
              boundary === "second-candidate" && data === '{"revision":2}\n' ||
              boundary === "journal" && data.includes('"records"')
            )
          ) throw primary;
          write(file, data, options);
        };
        assertStrictEquals(
          assertThrows(
            () => {
              parts.push(
                one.prepareParticipant(
                  { revision: 1 },
                  before[0],
                  lease.lease,
                  SET,
                  "one",
                ),
              );
              parts.push(
                two.prepareParticipant(
                  { revision: 2 },
                  before[1],
                  lease.lease,
                  SET,
                  "two",
                ),
              );
              set = createPublicationSet(SET, parts, journalPath(root));
              set.validate();
              const journal = new IdentityFile(
                `${root}/journal.json`,
                (value) => value,
                null,
              );
              journal.commit({
                setId: SET,
                phase: "prepared",
                records: set.records,
              });
            },
            Error,
            primary.message,
          ),
          primary,
        );
      } finally {
        Deno.writeTextFileSync = write;
        if (set) set.discard();
        for (const part of parts) part.discard();
      }
      assertStrictEquals(one.capture(), before[0]);
      assertStrictEquals(two.capture(), before[1]);
      assertEquals([...Deno.readDirSync(root)], []);
    }));
}

Deno.test("publication set: a later participant authority cannot change an earlier file after its last validation", () =>
  fixture((root, scope) => {
    const { one, two } = pair(root);
    let armed = false;
    const a = createOperationLease("live", [() => undefined]);
    const b = createOperationLease("live", [() => {
      if (armed) Deno.writeTextFileSync(`${root}/one.json`, "foreign");
      return undefined;
    }]);
    scope.defer(() => {
      a.retire();
      b.retire();
    });
    const parts = preparePair(scope, { one, two }, a.lease, b.lease);
    const set = createPublicationSet(SET, parts, journalPath(root));
    scope.defer(() => set.discard());
    armed = true;
    assertThrows(() => set.decide(), StoredConfigConflict, conflict);
    set.discard();
    assertEquals([
      Deno.readTextFileSync(`${root}/one.json`),
      two.capture().value,
      [...Deno.readDirSync(root)].map((e) => e.name),
    ], ["foreign", { revision: 0 }, ["one.json"]]);
  }));

Deno.test("publication set: a disguised rejected observer is reported without an unhandled rejection", () =>
  fixture((root, scope) => {
    const file = new IdentityFile(
      `${root}/one.json`,
      validateRevision,
      { revision: 0 },
      (() =>
        Promise.reject(new Error("observer rejection"))) as unknown as () =>
          undefined,
    );
    const lease = createOperationLease("live", [() => undefined]);
    scope.defer(() => lease.retire());
    const set = createPublicationSet(SET, [
      ownParticipant(
        scope,
        file.prepareParticipant(
          { revision: 1 },
          file.capture(),
          lease.lease,
          SET,
          "one",
        ),
      ),
    ], journalPath(root));
    scope.defer(() => set.discard());
    set.decide();
    assertEquals(set.publish().state, "committed");
    assertEquals(set.release().notificationFailed, true);
    assertEquals(file.capture().value, { revision: 1 });
  }));

interface Journal {
  setId: string;
  phase: "prepared" | "decided";
  records: RecordedCandidateData[];
}

for (const decision of ["prepared", "decided"] as const) {
  Deno.test(`publication recovery: failed sibling admission cannot delete ${decision} journal candidates`, () =>
    fixture((root, scope) => {
      const original = stagedPair(root, scope);
      if (decision === "decided") original.set.decide();
      const recovery = acquireOfflineRecovery(root);
      scope.defer(() => recovery.close());
      const one = new IdentityFile(`${root}/one.json`, validateRevision, {
        revision: 0,
      });
      const two = new IdentityFile(`${root}/two.json`, (value) => {
        const valid = validateRevision(value);
        if (valid.revision === 2) {
          throw new Error("recovery validation failure");
        }
        return valid;
      }, { revision: 0 });
      const first = one.recoverParticipant(
        original.set.records[0],
        recovery.authority,
        SET,
        "one",
        decision,
      );
      scope.defer(() => first.discard());
      assertThrows(
        () =>
          two.recoverParticipant(
            original.set.records[1],
            recovery.authority,
            SET,
            "two",
            decision,
          ),
        Error,
        "recovery validation failure",
      );
      first.discard();
      assertThrows(() => one.capture(), PublicationSetUnavailable, unavailable);
      assertThrows(() => two.capture(), PublicationSetUnavailable, unavailable);
      assertEquals(
        original.set.records.map((record) =>
          Deno.readTextFileSync(`${root}/${record.candidate}`)
        ),
        ['{"revision":1}\n', '{"revision":2}\n'],
      );
      if (decision === "decided") {
        assertEquals(original.set.publish().state, "committed");
        original.set.release();
      } else original.set.discard();
    }));
}
const journalSchema = objectRecordSchema<Journal>("G1 journal", (value) => {
  if (
    Object.keys(value).sort().join() !== "phase,records,setId" ||
    value.setId !== SET ||
    (value.phase !== "prepared" && value.phase !== "decided") ||
    !Array.isArray(value.records) || value.records.length !== 2
  ) throw new Error("invalid journal");
  return value as unknown as Journal;
});

Deno.test("publication recovery: journal decoder rejects an array that coerces to decided", () =>
  fixture((root, scope) => {
    const { set } = stagedPair(root, scope);
    Deno.writeTextFileSync(
      `${root}/journal.json`,
      JSON.stringify({
        setId: SET,
        phase: ["decided"],
        records: set.records,
      }),
    );
    scope.defer(() => retireJournal(root));
    const journal = recordReader(
      openRecordDirectory(scope, root),
      "journal.json",
      journalSchema,
    );
    assertThrows(() => journal.read(), Error, "invalid journal");
  }));

for (const phase of ["prepared", "decided", "half", "installed"] as const) {
  Deno.test(`publication set: real ${phase} child loss reopens exact pair and second recovery is idempotent`, () =>
    fixture(async (root, scope) => {
      const child = (await spawnOwnedChild(scope, DENO, {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-run",
          "--allow-net",
          fromFileUrl(
            new URL("./helpers/recorded_publication_child.ts", import.meta.url),
          ),
          root,
          phase,
          SET,
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
      const error = await stderr;
      assertEquals(error.includes(`G1 recorded crash: ${phase}`), true);
      const saved = recordReader(
        openRecordDirectory(scope, root),
        "journal.json",
        journalSchema,
      ).read()!.value;
      assertEquals(
        [saved.setId, saved.phase, saved.records.map((r) => r.role)],
        [SET, phase === "prepared" ? "prepared" : "decided", ["one", "two"]],
      );
      const before = ["one", "two"].map((name) => {
        try {
          return Deno.readTextFileSync(`${root}/${name}.json`);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return null;
          throw error;
        }
      });
      assertEquals(
        before,
        phase === "half"
          ? ['{"revision":1}\n', null]
          : phase === "installed"
          ? ['{"revision":1}\n', '{"revision":2}\n']
          : [null, null],
      );
      const recovery = acquireOfflineRecovery(root);
      scope.defer(() => recovery.close());
      const events: unknown[] = [], fresh = pair(root, events);
      const replay = recoverSet(
        root,
        scope,
        [fresh.one, fresh.two],
        saved.records,
        recovery.authority,
        saved.phase,
      );
      if (saved.phase === "prepared") {
        assertThrows(
          () => replay.discard(),
          PublicationSetUnavailable,
          unavailable,
        );
        replay.discard(() => retireJournal(root));
      } else {
        replay.decide();
        assertEquals(replay.publish().state, "committed");
        assertThrows(
          () => replay.release(),
          PublicationSetUnavailable,
          unavailable,
        );
        assertEquals(events, []);
        for (const file of [fresh.one, fresh.two]) {
          assertThrows(
            () => file.capture(),
            PublicationSetUnavailable,
            unavailable,
          );
        }
        retireJournal(root);
        replay.release();
      }
      const expected = saved.phase === "prepared"
        ? [{ revision: 0 }, { revision: 0 }]
        : [{ revision: 1 }, { revision: 2 }];
      assertEquals(
        [fresh.one.capture().value, fresh.two.capture().value],
        expected,
      );
      assertEquals(
        events,
        saved.phase === "prepared"
          ? []
          : [["one", ...expected], ["two", ...expected]],
      );
      if (saved.phase === "decided") {
        const again = pair(root);
        const second = recoverSet(
          root,
          scope,
          [again.one, again.two],
          saved.records,
          recovery.authority,
          saved.phase,
        );
        second.decide();
        assertEquals(second.publish().state, "committed");
        second.release();
        assertEquals([
          again.one.capture().persistence,
          again.two.capture().persistence,
        ], saved.records.map((r) => r.after));
      }
      assertEquals(
        [...Deno.readDirSync(root)].map((e) => e.name).sort(),
        saved.phase === "prepared"
          ? ["identity.lock"]
          : ["identity.lock", "one.json", "two.json"],
      );
    }));
}
