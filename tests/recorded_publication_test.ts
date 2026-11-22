// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { BoundFileStore } from "../server/config/file_store.ts";
import { StoredConfigConflict } from "../server/config/publication_outcome.ts";
import { recordedWriter } from "../server/config/internal/publication_port.ts";
import { acquireOfflineRecovery } from "../server/auth/offline_recovery.ts";
import { IdentityFile } from "../server/auth/records.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { OwnershipError } from "../shared/ownership.js";

const SET = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const raw = '{"revision":1}\n';
const conflict = "Stored configuration changed before commit.";

Deno.test("recorded candidates: private writer rejects forged instances", () => {
  assertThrows(
    () => recordedWriter({}),
    TypeError,
    "Recorded publication requires an issued writer.",
  );
});
function fixture(
  run: (
    root: string,
    scope: Parameters<Parameters<typeof fixtureScope>[0]>[0],
  ) => void,
) {
  return fixtureScope(async (scope) => {
    const root = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "recorded-publication-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    await scope.admit(() => run(root.value, scope));
  });
}
function prepare(root: string) {
  const store = new BoundFileStore(`${root}/record.json`, root);
  const lifetime = createOperationLease("live", [() => undefined]);
  return {
    store,
    lifetime,
    candidate: recordedWriter(store).prepare(
      raw,
      store.capture(),
      lifetime.lease,
      SET,
      "account",
    ),
  };
}

Deno.test("recorded candidates: reentrant discard revokes the final native effect", () =>
  fixture((root, scope) => {
    const store = new BoundFileStore(`${root}/record.json`, root);
    let armed = false;
    const lifetime = createOperationLease("live", [() => {
      if (armed) candidate.discard();
      return undefined;
    }]);
    const candidate = recordedWriter(store).prepare(
      raw,
      store.capture(),
      lifetime.lease,
      SET,
      "account",
    );
    scope.defer(() => {
      candidate.discard();
      lifetime.retire();
    });
    armed = true;
    assertThrows(() => candidate.apply(), StoredConfigConflict, conflict);
    assertEquals([store.capture().raw, [...Deno.readDirSync(root)]], [
      null,
      [],
    ]);
  }));

Deno.test("recorded candidates: admitted records are immutable and stale replay cannot overwrite a later edit", () =>
  fixture((root, scope) => {
    const { store, candidate } = prepare(root);
    scope.defer(() => candidate.discard());
    const recovery = acquireOfflineRecovery(root);
    scope.defer(() => recovery.close());
    const data = JSON.parse(JSON.stringify(candidate.record));
    const replay = recordedWriter(store).recover(
      data,
      recovery.authority,
      SET,
      "account",
    );
    scope.defer(() => replay.discard());
    assertThrows(
      () =>
        Object.defineProperty(replay.record.after, "raw", { value: "foreign" }),
      TypeError,
      "Cannot redefine property: raw",
    );
    data.after.raw = "foreign";
    replay.apply();
    const after = store.capture();
    store.replace('{"revision":2}\n', after);
    assertThrows(() => replay.apply(), StoredConfigConflict, conflict);
    assertThrows(
      () =>
        recordedWriter(store).recover(
          candidate.record,
          recovery.authority,
          SET,
          "account",
        ),
      StoredConfigConflict,
      conflict,
    );
    assertEquals(store.capture().raw, '{"revision":2}\n');
  }));

Deno.test("recorded candidates: preparation leaves live bytes untouched; recovery applies exact record and is idempotent", () =>
  fixture((root, scope) => {
    const { store, lifetime, candidate } = prepare(root);
    scope.defer(() => {
      candidate.discard();
      lifetime.retire();
    });
    const recovery = acquireOfflineRecovery(root);
    scope.defer(() => recovery.close());
    const data = JSON.parse(JSON.stringify(candidate.record));
    assertEquals(store.capture().raw, null);
    assertEquals(
      Deno.statSync(`${root}/${data.candidate}`).mode! & 0o777,
      0o600,
    );
    const reopened = new BoundFileStore(store.filename, root);
    const replay = recordedWriter(reopened).recover(
      data,
      recovery.authority,
      SET,
      "account",
    );
    scope.defer(() => replay.discard());
    assertEquals(replay.apply(), {
      snapshot: candidate.record.after,
      warning: false,
    });
    assertEquals(reopened.capture(), candidate.record.after);
    assertEquals(replay.apply(), {
      snapshot: candidate.record.after,
      warning: false,
    });
    const again = recordedWriter(new BoundFileStore(store.filename, root))
      .recover(data, recovery.authority, SET, "account");
    scope.defer(() => again.discard());
    assertEquals(again.apply(), {
      snapshot: candidate.record.after,
      warning: false,
    });
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name).sort(), [
      "identity.lock",
      "record.json",
    ]);
  }));

Deno.test("recorded candidates: undecided recovery discards only its alias and cannot publish", () =>
  fixture((root, scope) => {
    const { store, candidate } = prepare(root);
    scope.defer(() => candidate.discard());
    const recovery = acquireOfflineRecovery(root);
    scope.defer(() => recovery.close());
    const replay = recordedWriter(store).recover(
      candidate.record,
      recovery.authority,
      SET,
      "account",
    );
    replay.discard();
    replay.discard();
    assertThrows(() => replay.apply(), OwnershipError, "Owner is retired");
    assertEquals(store.capture().raw, null);
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), [
      "identity.lock",
    ]);
  }));

for (const kind of ["forged", "clone", "foreign", "retired"] as const) {
  Deno.test(`recorded candidates: ${kind} recovery owner cannot reconstruct authority`, () =>
    fixture((root, scope) => {
      const { store, candidate } = prepare(root);
      scope.defer(() => candidate.discard());
      const recovery = acquireOfflineRecovery(
        kind === "foreign" ? `${root}/other` : root,
      );
      scope.defer(() => recovery.close());
      const authority = kind === "forged"
        ? {}
        : kind === "clone"
        ? { ...recovery.authority }
        : recovery.authority;
      if (kind === "retired") recovery.close();
      if (kind === "retired") {
        assertThrows(
          () =>
            recordedWriter(store).recover(
              candidate.record,
              authority,
              SET,
              "account",
            ),
          OwnershipError,
          "Owner is retired",
        );
      } else {
        assertThrows(
          () =>
            recordedWriter(store).recover(
              candidate.record,
              authority,
              SET,
              "account",
            ),
          TypeError,
          "Publication recovery requires the exclusive root owner.",
        );
      }
      assertEquals(store.capture().raw, null);
      assertEquals(
        Deno.readTextFileSync(`${root}/${candidate.record.candidate}`),
        raw,
      );
    }));
}

for (
  const kind of [
    "extra",
    "path",
    "set",
    "role",
    "destination",
    "parent",
    "identity",
    "after",
    "bytes",
  ] as const
) {
  Deno.test(`recorded candidates: malformed or foreign ${kind} record rejects without effects`, () =>
    fixture((root, scope) => {
      const { store, candidate } = prepare(root);
      scope.defer(() => candidate.discard());
      const recovery = acquireOfflineRecovery(root);
      scope.defer(() => recovery.close());
      const data = JSON.parse(JSON.stringify(candidate.record));
      if (kind === "extra") data.extra = true;
      if (kind === "path") data.candidate = "../record.json";
      if (kind === "set") data.setId = OTHER;
      if (kind === "role") data.role = "acl";
      if (kind === "destination") {
        data.before.binding.configured = `${root}/foreign`;
      }
      if (kind === "parent") data.before.binding.nodes[0].identity.ino++;
      if (kind === "identity") data.after.binding.nodes.at(-1).identity.ino++;
      if (kind === "after") {
        data.after.binding.nodes.push(data.after.binding.nodes[0]);
      }
      if (kind === "bytes") data.after.raw = "foreign";
      assertThrows(
        () =>
          recordedWriter(store).recover(
            data,
            recovery.authority,
            SET,
            "account",
          ),
        StoredConfigConflict,
        conflict,
      );
      assertEquals([
        store.capture().raw,
        Deno.readTextFileSync(`${root}/${candidate.record.candidate}`),
      ], [null, raw]);
    }));
}

Deno.test("recorded candidates: failed discard revokes publication, exact cleanup retries and foreign aliases survive", () =>
  fixture((root, scope) => {
    const { store, candidate } = prepare(root);
    scope.defer(() => candidate.discard());
    const file = `${root}/${candidate.record.candidate}`;
    const remove = Deno.removeSync, failure = new Error("unlink denied");
    try {
      Deno.removeSync = () => {
        throw failure;
      };
      assertStrictEquals(
        assertThrows(() => candidate.discard(), Error, failure.message),
        failure,
      );
    } finally {
      Deno.removeSync = remove;
    }
    assertThrows(() => candidate.apply(), OwnershipError, "Owner is retired");
    Deno.renameSync(file, `${root}/original`);
    Deno.writeTextFileSync(file, "foreign");
    assertThrows(() => candidate.discard(), StoredConfigConflict, conflict);
    assertEquals(Deno.readTextFileSync(file), "foreign");
    remove(file);
    candidate.discard();
    assertEquals([
      store.capture().raw,
      Deno.readTextFileSync(`${root}/original`),
    ], [null, raw]);
  }));

Deno.test("recorded candidates: committed cleanup warning is separate, retry never republishes", () =>
  fixture((root, scope) => {
    const { store, candidate } = prepare(root);
    scope.defer(() => candidate.discard());
    const remove = Deno.removeSync;
    try {
      Deno.removeSync = () => {
        throw new Error("unlink denied");
      };
      assertEquals(candidate.apply(), {
        snapshot: candidate.record.after,
        warning: true,
      });
    } finally {
      Deno.removeSync = remove;
    }
    assertEquals(store.capture(), candidate.record.after);
    candidate.discard();
    assertEquals(store.capture().raw, raw);
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), [
      "record.json",
    ]);
  }));

Deno.test("IdentityFile: synchronous notification observes installed snapshot; observer failure stays committed", () =>
  fixture((root) => {
    const events: unknown[] = [];
    const file = new IdentityFile(
      `${root}/record.json`,
      (v) => v as { revision: number },
      { revision: 0 },
      () => {
        events.push([
          file.capture().value,
          Deno.readTextFileSync(`${root}/record.json`),
        ]);
        throw new Error("observer failure");
      },
    );
    assertEquals(file.commit({ revision: 1 }), { revision: 1 });
    assertEquals(events, [[{ revision: 1 }, raw]]);
  }));
