// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  BoundFileStore,
  PublicationRecoveryRequired,
  StoredConfigConflict,
  type StoredConfigSnapshot,
} from "../server/config/file_store.ts";
import { createOwnedPublication } from "../server/config/owned_publication.ts";
import {
  prepareStoredPublication,
  registerPublicationWriter,
} from "../server/config/internal/publication_port.ts";
import {
  createOperationLease,
  type OperationLease,
} from "../server/operation_lease.ts";
import { IdentityFile } from "../server/auth/records.ts";
import { logger } from "../server/logger.ts";
import { storedDurabilityStatus } from "../server/config/durability.ts";
import { observeDurability } from "./helpers/durability.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { OwnershipError } from "../shared/ownership.js";

const secret = "publication-fixture-secret";
type Value = { revision: number; secret: string };
const next = (revision: number): Value => ({ revision, secret });
function fixture(run: (root: string) => void) {
  return fixtureScope(async (scope) => {
    const root = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "owned-publication-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    await scope.admit(() => run(root.value));
  });
}
const candidates = (root: string) =>
  [...Deno.readDirSync(root)].filter((e) => e.name.startsWith(".config-")).map(
    (e) => `${root}/${e.name}`,
  );
function binding(
  root: string,
  install?: (value: Value, snapshot: StoredConfigSnapshot) => undefined,
  notify?: () => undefined,
) {
  const store = new BoundFileStore(`${root}/record.json`);
  let value = next(0), persistence = store.capture();
  const owner = createOwnedPublication<Value>(
    store,
    install ?? ((v, s) => {
      value = v;
      persistence = s;
      return undefined;
    }),
    notify,
  );
  return {
    store,
    owner,
    get value() {
      return value;
    },
    get persistence() {
      return persistence;
    },
  };
}
const live = () => createOperationLease("live", [() => undefined]);
const validate = (input: unknown): Value => {
  const v = input as Value;
  if (!Number.isSafeInteger(v?.revision) || typeof v.secret !== "string") {
    throw new Error("invalid record");
  }
  return v;
};

Deno.test("owned publication pilot: synchronous guard values preserve the void compatibility contract", () =>
  fixture((root) => {
    const file = new IdentityFile(`${root}/record.json`, validate, next(0));
    const checked = new Set<number>();
    for (const revision of [1, 2]) {
      assertEquals(
        file.commit(
          next(revision),
          file.capture(),
          () => checked.add(revision),
        ),
        next(revision),
      );
    }
    assertEquals([...checked], [1, 2]);
    assertEquals(
      new IdentityFile(`${root}/record.json`, validate, next(0)).capture()
        .value,
      next(2),
    );
    assertEquals(candidates(root), []);
  }));

for (const kind of ["async", "thenable"] as const) {
  Deno.test(`owned publication pilot: ${kind} guard rejects before staging`, () =>
    fixture((root) => {
      const file = new IdentityFile(`${root}/record.json`, validate, next(0));
      const before = file.capture();
      let entered = 0;
      const guard = kind === "async"
        ? async () => {
          entered++;
          await Promise.resolve();
        }
        : () => {
          entered++;
          return { then() {} };
        };
      assertThrows(
        () => file.commit(next(1), before, guard),
        TypeError,
        "Identity guards must be synchronous.",
      );
      assertEquals(entered, kind === "async" ? 0 : 1);
      assertStrictEquals(file.capture(), before);
      assertEquals([...Deno.readDirSync(root)], []);
    }));
}

Deno.test("owned publication: first candidate pathname stat failure releases its owned file", () =>
  fixture((root) => {
    const b = binding(root), stat = Deno.lstatSync;
    const primary = new Error("first candidate stat");
    let failed = false;
    try {
      Deno.lstatSync = ((file) => {
        if (!failed && String(file).includes("/.config-")) {
          failed = true;
          throw primary;
        }
        return stat(file);
      }) as typeof stat;
      const error = assertThrows(
        () => b.owner.prepare(next(1), b.persistence, live().lease),
        Error,
        primary.message,
      );
      assertStrictEquals(error, primary);
    } finally {
      Deno.lstatSync = stat;
    }
    assertEquals(failed, true);
    assertEquals(candidates(root), []);
    assertEquals([b.value, b.store.capture().raw], [next(0), null]);
  }));

for (const replacement of [false, true]) {
  Deno.test(`owned publication: failed original-handle identity acquisition retains custody, foreign replacement=${replacement}`, () =>
    fixture((root) => {
      const b = binding(root), open = Deno.openSync, remove = Deno.removeSync;
      const primary = new Error("original handle identity unavailable");
      const cleanup = new Error("cleanup identity unavailable");
      const events: string[] = [], removed: string[] = [];
      let temporary = "", blocked = true, attempts = 0;
      try {
        Deno.openSync = ((file, options) => {
          const handle = open(file, options);
          if (options?.createNew && String(file).includes("/.config-")) {
            temporary = String(file);
            const stat = handle.statSync.bind(handle),
              close = handle.close.bind(handle);
            handle.statSync = () => {
              events.push("stat");
              attempts++;
              if (blocked) {
                if (replacement && attempts === 1) {
                  Deno.renameSync(temporary, `${root}/original`);
                  Deno.writeTextFileSync(temporary, "foreign bytes");
                }
                throw attempts === 1 ? primary : cleanup;
              }
              return stat();
            };
            handle.close = () => {
              events.push("close");
              close();
            };
          }
          return handle;
        }) as typeof open;
        Deno.removeSync = ((file, options) => {
          removed.push(String(file));
          remove(file, options);
        }) as typeof remove;
        const error = assertThrows(
          () => b.owner.prepare(next(1), b.persistence, live().lease),
          AggregateError,
          "Stored preparation and cleanup failed.",
        );
        assertStrictEquals(error.cause, primary);
        assertEquals(error.errors, [primary, cleanup]);
        assertStrictEquals(error.errors[0], primary);
        assertStrictEquals(error.errors[1], cleanup);
        assertEquals([
          events,
          removed,
          candidates(root),
          b.value,
          b.store.capture().raw,
        ], [["stat", "stat"], [], [temporary], next(0), null]);
        blocked = false;
        // Recover identity from the retained original descriptor, never the path.
        Deno.openSync = open;
        const pending = b.owner.prepare(next(2), b.persistence, live().lease);
        assertEquals(
          events,
          replacement
            ? ["stat", "stat", "stat"]
            : ["stat", "stat", "stat", "close"],
        );
        assertEquals(removed, replacement ? [] : [temporary]);
        pending.discard();
        if (replacement) {
          assertEquals(candidates(root), [temporary]);
          assertEquals(Deno.readTextFileSync(temporary), "foreign bytes");
          remove(temporary);
          Deno.renameSync(`${root}/original`, temporary);
        }
        b.owner.prepare(next(3), b.persistence, live().lease).publish();
        assertEquals(
          events,
          replacement
            ? ["stat", "stat", "stat", "stat", "close"]
            : ["stat", "stat", "stat", "close"],
        );
        assertEquals(candidates(root), []);
        assertEquals(
          new IdentityFile(b.store.filename, validate, next(0)).capture().value,
          next(3),
        );
      } finally {
        blocked = false;
        Deno.openSync = open;
        Deno.removeSync = remove;
      }
    }));
}

for (const committed of [false, true]) {
  Deno.test(`owned publication: live-inode custody survives failed cleanup and foreign replacement, committed=${committed}`, () =>
    fixture((root) => {
      const b = binding(root), open = Deno.openSync, remove = Deno.removeSync;
      const handles: { file: string; handle: Deno.FsFile; closed: boolean }[] =
        [];
      const closed: string[] = [];
      const cleanup = new Error("candidate unlink unavailable");
      let prepared: ReturnType<typeof b.owner.prepare> | undefined;
      let pending: ReturnType<typeof b.owner.prepare> | undefined;
      try {
        Deno.openSync = ((file, options) => {
          const handle = open(file, options);
          if (options?.createNew && String(file).includes("/.config-")) {
            const entry = { file: String(file), handle, closed: false };
            const close = handle.close.bind(handle);
            handle.close = () => {
              close();
              entry.closed = true;
              closed.push(entry.file);
            };
            handles.push(entry);
          }
          return handle;
        }) as typeof open;
        prepared = b.owner.prepare(next(1), b.persistence, live().lease);
        const [original] = handles;
        Deno.removeSync = () => {
          throw cleanup;
        };
        if (committed) {
          const outcome = prepared.publish();
          assertEquals([outcome.state, outcome.warning], [
            "committed",
            "stored-durability-unconfirmed",
          ]);
        } else {
          assertStrictEquals(
            assertThrows(() => prepared!.discard(), Error, cleanup.message),
            cleanup,
          );
        }
        Deno.removeSync = remove;
        // Remove the candidate's last name in the unpublished case. An open
        // descriptor must still pin its inode while foreign bytes take its name.
        remove(original.file);
        Deno.writeTextFileSync(original.file, "foreign replacement");
        assertEquals(closed, []);
        assertEquals(original.handle.statSync().nlink, committed ? 1 : 0);
        assertThrows(
          () => prepared!.discard(),
          StoredConfigConflict,
          "Stored configuration changed before commit.",
        );
        assertEquals([Deno.readTextFileSync(original.file), closed], [
          "foreign replacement",
          [],
        ]);
        pending = b.owner.prepare(next(2), b.persistence, live().lease);
        assertEquals([Deno.readTextFileSync(original.file), closed], [
          "foreign replacement",
          [],
        ]);
        const [, second] = handles;
        pending.discard();
        assertEquals(closed, [second.file]);
        remove(original.file);
        prepared.discard();
        prepared.discard();
        assertEquals(closed, [second.file, original.file]);
        assertThrows(
          () => original.handle.statSync(),
          Deno.errors.BadResource,
          "Bad resource ID",
        );
        assertEquals(candidates(root), []);
        assertEquals(
          [b.value, b.store.capture().raw],
          committed
            ? [next(1), JSON.stringify(next(1)) + "\n"]
            : [next(0), null],
        );
      } finally {
        Deno.openSync = open;
        Deno.removeSync = remove;
        // Test custody also covers an assertion failure before normal disposal.
        for (const entry of handles) {
          if (!entry.closed) entry.handle.close();
        }
      }
    }));
}

Deno.test("owned publication: lost descriptor cannot authorize a cached-identity unlink after inode reuse", () =>
  fixture((root) => {
    const b = binding(root),
      open = Deno.openSync,
      remove = Deno.removeSync,
      stat = Deno.lstatSync;
    let original: Deno.FsFile | undefined,
      originalInfo: Deno.FileInfo | undefined,
      closed = false;
    const removed: string[] = [];
    try {
      Deno.openSync = ((file, options) => {
        const handle = open(file, options);
        if (options?.createNew && String(file).includes("/.config-")) {
          original = handle;
          originalInfo = handle.statSync();
          const close = handle.close.bind(handle);
          handle.close = () => {
            close();
            closed = true;
          };
        }
        return handle;
      }) as typeof open;
      const prepared = b.owner.prepare(next(1), b.persistence, live().lease);
      const [temporary] = candidates(root),
        cleanup = new Error("unlink unavailable");
      Deno.removeSync = () => {
        throw cleanup;
      };
      assertStrictEquals(
        assertThrows(() => prepared.discard(), Error, cleanup.message),
        cleanup,
      );
      // Simulate an unexpectedly lost descriptor, followed by reuse of its freed
      // inode number. Never depend on the filesystem allocator to reuse it.
      if (!closed) original!.close();
      remove(temporary);
      Deno.writeTextFileSync(temporary, "foreign reused-inode file");
      Deno.lstatSync = ((file) => {
        const info = stat(file);
        return String(file) === temporary
          ? { ...info, dev: originalInfo!.dev, ino: originalInfo!.ino }
          : info;
      }) as typeof stat;
      Deno.removeSync = ((file, options) => {
        removed.push(String(file));
        remove(file, options);
      }) as typeof remove;
      assertThrows(
        () => prepared.discard(),
        Deno.errors.BadResource,
        "Bad resource ID",
      );
      assertThrows(
        () => prepared.discard(),
        StoredConfigConflict,
        "Stored configuration changed before commit.",
      );
      assertEquals([
        removed,
        Deno.readTextFileSync(temporary),
        b.store.capture().raw,
      ], [[], "foreign reused-inode file", null]);
    } finally {
      Deno.openSync = open;
      Deno.removeSync = remove;
      Deno.lstatSync = stat;
      if (original && !closed) original.close();
    }
  }));

for (const retry of ["handle", "store"] as const) {
  Deno.test(`owned publication: committed alias cleanup is retried by ${retry} without publication replay`, () =>
    fixture((root) => {
      const b = binding(root),
        remove = Deno.removeSync,
        link = Deno.linkSync,
        rename = Deno.renameSync;
      const effects: string[] = [];
      let retained: string[] = [];
      try {
        Deno.linkSync = (from, to) => {
          effects.push("link");
          link(from, to);
        };
        Deno.renameSync = (from, to) => {
          effects.push("rename");
          rename(from, to);
        };
        Deno.removeSync = ((file, options) => {
          if (String(file).includes("/.config-")) {
            throw new Error("alias cleanup");
          }
          remove(file, options);
        }) as typeof remove;
        {
          const prepared = b.owner.prepare(
            next(1),
            b.persistence,
            live().lease,
          );
          retained = candidates(root);
          const outcome = prepared.publish();
          assertEquals([outcome.state, outcome.warning, b.value], [
            "committed",
            "stored-durability-unconfirmed",
            next(1),
          ]);
          assertEquals(candidates(root), retained);
          Deno.removeSync = remove;
          if (retry === "handle") {
            prepared.discard();
            assertThrows(
              () => prepared.publish(),
              StoredConfigConflict,
              "Stored configuration changed before commit.",
            );
            assertEquals(candidates(root), []);
          }
        }
        // The store case drops the prepared handle at this boundary.
        b.owner.prepare(next(2), b.persistence, live().lease).publish();
        assertEquals(candidates(root), []);
        assertEquals(effects, ["link", "rename"]);
        assertEquals(
          new IdentityFile(b.store.filename, validate, next(0)).capture().value,
          next(2),
        );
      } finally {
        Deno.removeSync = remove;
        Deno.linkSync = link;
        Deno.renameSync = rename;
      }
    }));
}

for (const reenter of [false, true]) {
  Deno.test(`owned publication: failed discard revokes authority before cleanup and remains cleanup-only, reenter=${reenter}`, () =>
    fixture((root) => {
      const b = binding(root),
        prepared = b.owner.prepare(next(1), b.persistence, live().lease);
      const retained = candidates(root), remove = Deno.removeSync;
      const cleanup = new Error("discard cleanup");
      let reentered: unknown;
      try {
        Deno.removeSync = () => {
          if (reenter) {
            try {
              prepared.publish();
            } catch (error) {
              reentered = error;
            }
          }
          throw cleanup;
        };
        assertStrictEquals(
          assertThrows(() => prepared.discard(), Error, cleanup.message),
          cleanup,
        );
      } finally {
        Deno.removeSync = remove;
      }
      assertEquals(reentered instanceof StoredConfigConflict, reenter);
      assertEquals([b.value, b.store.capture().raw, candidates(root)], [
        next(0),
        null,
        retained,
      ]);
      assertThrows(
        () => prepared.publish(),
        StoredConfigConflict,
        "Stored configuration changed before commit.",
      );
      prepared.discard();
      assertEquals(candidates(root), []);
      assertEquals([b.value, b.store.capture().raw], [next(0), null]);
    }));
}

function staticContract() {
  const b = binding("/unexecuted"), operation = live();
  // @ts-expect-error The private preparation port is not a public store method.
  void b.store.preparePublication;
  // @ts-expect-error A live issued lease is required.
  b.owner.prepare(next(1), b.persistence);
  b.owner.prepare(
    next(1),
    b.persistence,
    // @ts-expect-error An outcome lease is not write authority.
    createOperationLease("outcome", [() => undefined]).lease,
  );
  const prepared = b.owner.prepare(next(1), b.persistence, operation.lease);
  // @ts-expect-error No arbitrary final-effect callback.
  prepared.publish(() => Deno.writeTextFileSync("/unexecuted", secret));
  // @ts-expect-error async-to-void assignment is not an installation contract.
  createOwnedPublication<Value>(b.store, async () => {});
}
void staticContract;

Deno.test("owned publication: preparation is a private exact-instance capability, not a public store method", () =>
  fixture((root) => {
    const b = binding(root), operation = live();
    assertEquals(Reflect.get(b.store, "preparePublication"), undefined);
    assertEquals(
      Reflect.get(Object.getPrototypeOf(b.store), "preparePublication"),
      undefined,
    );
    assertThrows(
      () =>
        registerPublicationWriter(b.store, () => {
          throw new Error("replacement must not run");
        }),
      TypeError,
    );
    for (
      const forged of [
        {},
        { ...b.store },
        Object.create(Object.getPrototypeOf(b.store)),
      ]
    ) {
      assertThrows(
        () =>
          prepareStoredPublication(
            forged,
            JSON.stringify(next(1)),
            b.persistence,
            operation.lease,
            () => undefined,
          ),
        TypeError,
      );
    }
    assertEquals(candidates(root), []);
    b.owner.prepare(next(1), b.persistence, operation.lease).publish();
    assertEquals(b.value, next(1));
    assertEquals(JSON.parse(Deno.readTextFileSync(b.store.filename)), next(1));
  }));

Deno.test("owned publication: immutable prepared value, exact snapshot, consumer after installation and single-use receipt", () =>
  fixture((root) => {
    const b = binding(root), operation = live(), input = next(1);
    const prepared = b.owner.prepare(input, b.persistence, operation.lease);
    assertEquals(b.value.revision, 0);
    assertEquals(b.store.capture().raw, null);
    input.revision = 99;
    const outcome = prepared.publish();
    assertEquals(outcome.state, "committed");
    assertEquals(outcome.warning, null);
    assertStrictEquals(outcome.operation, operation.lease.identity);
    assert(Object.isFrozen(outcome));
    assert(Object.isFrozen(b.value));
    assertEquals(b.value, next(1));
    assertEquals(b.persistence, b.store.capture());
    assertEquals(JSON.parse(Deno.readTextFileSync(b.store.filename)), next(1));
    assertThrows(() => prepared.publish(), StoredConfigConflict);
    prepared.discard();
    assertEquals(b.store.capture().raw, JSON.stringify(next(1)) + "\n");
    assertEquals(candidates(root), []);
  }));

Deno.test("owned publication: missing, forged, cloned and wrong-mode leases reject before candidate acquisition", () =>
  fixture((root) => {
    const b = binding(root), operation = live();
    for (
      const lease of [
        undefined,
        {},
        { ...operation.lease },
        createOperationLease("outcome", [() => undefined]).lease,
      ]
    ) {
      assertThrows(
        () =>
          b.owner.prepare(
            next(1),
            b.persistence,
            lease as OperationLease<"live">,
          ),
        TypeError,
      );
      assertEquals(candidates(root), []);
      assertEquals(b.store.capture().raw, null);
    }
  }));

for (const reentrant of [false, true]) {
  Deno.test(`owned publication: ${reentrant ? "reentrant" : "explicit"} retirement after preparation fences the actual link and releases candidate`, () =>
    fixture((root) => {
      const b = binding(root);
      let armed = false;
      const operation = createOperationLease("live", [() => {
        if (armed) operation.retire();
        return undefined;
      }]);
      const prepared = b.owner.prepare(next(1), b.persistence, operation.lease);
      if (reentrant) armed = true;
      else operation.retire();
      assertThrows(() => prepared.publish());
      assertEquals(b.store.capture().raw, null);
      assertEquals(b.value.revision, 0);
      assertEquals(candidates(root), []);
    }));
}

Deno.test("owned publication: explicit discard is idempotent, inert and cannot publish later", () =>
  fixture((root) => {
    const b = binding(root),
      prepared = b.owner.prepare(next(1), b.persistence, live().lease);
    prepared.discard();
    prepared.discard();
    assertThrows(() => prepared.publish(), StoredConfigConflict);
    assertEquals(b.store.capture().raw, null);
    assertEquals(candidates(root), []);
  }));

Deno.test("owned publication: reentrant final witness cannot change target or candidate after storage validation", () =>
  fixture((root) => {
    const b = binding(root);
    b.owner.prepare(next(1), b.persistence, live().lease).publish();
    let armed = false;
    const operation = createOperationLease("live", [() => {
      if (armed) Deno.writeTextFileSync(b.store.filename, "foreign target");
      return undefined;
    }]);
    const prepared = b.owner.prepare(next(2), b.persistence, operation.lease);
    armed = true;
    assertThrows(() => prepared.publish(), StoredConfigConflict);
    assertEquals(Deno.readTextFileSync(b.store.filename), "foreign target");
    assertEquals(b.value, next(1));
    assertEquals(candidates(root), []);
  }));

Deno.test("owned publication: storage validation cannot retire its parent then publish", () =>
  fixture((root) => {
    const b = binding(root), operation = live();
    const prepared = b.owner.prepare(next(1), b.persistence, operation.lease);
    const validate = b.store.assertUnchanged.bind(b.store);
    b.store.assertUnchanged = (snapshot) => {
      validate(snapshot);
      operation.retire();
    };
    assertThrows(() => prepared.publish(), OwnershipError, "Owner is retired");
    assertEquals(b.store.capture().raw, null);
    assertEquals(b.value, next(0));
    assertEquals(candidates(root), []);
  }));

Deno.test("owned publication: a reentrant parent witness cannot publish the same candidate twice", () =>
  fixture((root) => {
    const events: string[] = [];
    const b = binding(root, () => {
      events.push("installed");
      return undefined;
    });
    let reenter = () => {};
    const operation = createOperationLease("live", [() => {
      reenter();
    }]);
    const prepared = b.owner.prepare(next(1), b.persistence, operation.lease);
    reenter = () => {
      reenter = () => {};
      assertThrows(
        () => prepared.publish(),
        StoredConfigConflict,
        "Stored configuration changed before commit.",
      );
      events.push("reentry rejected");
    };
    assertEquals(prepared.publish().state, "committed");
    assertEquals(events, ["reentry rejected", "installed"]);
    assertEquals(JSON.parse(Deno.readTextFileSync(b.store.filename)), next(1));
    assertEquals(candidates(root), []);
  }));

Deno.test("owned publication: same-inode candidate tampering rejects without exposing a different prepared value", () =>
  fixture((root) => {
    const b = binding(root),
      prepared = b.owner.prepare(next(1), b.persistence, live().lease);
    const [candidate] = candidates(root);
    Deno.writeTextFileSync(candidate, JSON.stringify(next(99)));
    assertThrows(() => prepared.publish(), StoredConfigConflict);
    assertEquals(b.store.capture().raw, null);
    assertEquals(b.value, next(0));
    assertEquals(candidates(root), []);
  }));

Deno.test("owned publication: two prepared first writers have one winner and the loser cleans only its candidate", () =>
  fixture((root) => {
    const b = binding(root), expected = b.persistence;
    const first = b.owner.prepare(next(1), expected, live().lease),
      second = b.owner.prepare(next(2), expected, live().lease);
    first.publish();
    assertThrows(() => second.publish(), StoredConfigConflict);
    assertEquals(b.value, next(1));
    assertEquals(candidates(root), []);
    b.owner.prepare(next(3), b.persistence, live().lease).publish();
    assertEquals(JSON.parse(Deno.readTextFileSync(b.store.filename)), next(3));
  }));

Deno.test("owned publication: foreign equal-byte candidate replacement is preserved, never adopted or deleted", () =>
  fixture((root) => {
    const b = binding(root),
      prepared = b.owner.prepare(next(1), b.persistence, live().lease);
    const [candidate] = candidates(root);
    Deno.renameSync(candidate, `${root}/retained-original`);
    Deno.writeTextFileSync(candidate, JSON.stringify(next(1)) + "\n");
    assertThrows(() => prepared.publish(), AggregateError);
    assertThrows(() => prepared.discard(), StoredConfigConflict);
    assertEquals(
      Deno.readTextFileSync(candidate),
      JSON.stringify(next(1)) + "\n",
    );
    assertEquals(b.store.capture().raw, null);
    assertEquals(b.value.revision, 0);
    // The test owns the foreign replacement; remove it before releasing the
    // descriptor that deliberately remained in cleanup custody after conflict.
    Deno.removeSync(candidate);
    prepared.discard();
  }));

for (const boundary of ["write", "sync", "link"]) {
  Deno.test(`owned publication: unpublished ${boundary} failure retains runtime/disk and releases exact candidate`, () =>
    fixture((root) => {
      const b = binding(root),
        write = Deno.writeTextFileSync,
        link = Deno.linkSync,
        open = Deno.openSync;
      const primary = new Error("unpublished fixture");
      try {
        if (boundary === "write") {
          Deno.writeTextFileSync = () => {
            throw primary;
          };
        }
        if (boundary === "link") {
          Deno.linkSync = () => {
            throw primary;
          };
        }
        if (boundary === "sync") {
          Deno.openSync = ((file, options) => {
            const handle = open(file, options);
            if (String(file).includes("/.config-")) {
              handle.syncSync = () => {
                throw primary;
              };
            }
            return handle;
          }) as typeof open;
        }
        assertStrictEquals(
          assertThrows(() =>
            b.owner.prepare(next(1), b.persistence, live().lease).publish()
          ),
          primary,
        );
      } finally {
        Deno.writeTextFileSync = write;
        Deno.linkSync = link;
        Deno.openSync = open;
      }
      assertEquals(b.value.revision, 0);
      assertEquals(b.store.capture().raw, null);
      assertEquals(candidates(root), []);
      b.owner.prepare(next(2), b.persistence, live().lease).publish();
      assertEquals(b.store.capture().raw, JSON.stringify(next(2)) + "\n");
    }));
}

for (
  const [existing, boundary] of [[false, "cleanup"], [false, "directory"], [
    false,
    "both",
  ], [true, "directory"]] as const
) {
  Deno.test(`owned publication: published ${existing ? "rename" : "link"} ${boundary} failure stays committed, secret-free and permits the next mutation`, () =>
    fixture((root) => {
      const b = binding(root);
      if (existing) {
        b.owner.prepare(next(1), b.persistence, live().lease).publish();
      }
      const remove = Deno.removeSync,
        link = Deno.linkSync,
        rename = Deno.renameSync,
        warning = logger.warning;
      const warnings: unknown[][] = [];
      const count = storedDurabilityStatus().warningCount;
      let published = false;
      try {
        logger.warning = (...args) => {
          warnings.push(args);
        };
        observeDurability((events, deny) => {
          const mark = () => {
            published = true;
            if (boundary !== "cleanup") deny(root);
          };
          const observedLink = Deno.linkSync, observedRename = Deno.renameSync;
          Deno.linkSync = (from, to) => {
            observedLink(from, to);
            mark();
          };
          Deno.renameSync = (from, to) => {
            observedRename(from, to);
            mark();
          };
          if (boundary !== "directory") {
            Deno.removeSync = ((file, options) => {
              if (
                published && String(file).includes("/.config-")
              ) throw new Error(secret + root);
              remove(file, options);
            }) as typeof remove;
          }
          const prepared = b.owner.prepare(
            next(2),
            b.persistence,
            live().lease,
          );
          const [candidate] = candidates(root);
          const outcome = prepared.publish();
          assertEquals(outcome.committed, true);
          assertEquals(outcome.state, "committed");
          assertEquals(outcome.warning, "stored-durability-unconfirmed");
          assertEquals(b.value, next(2));
          assertEquals(b.persistence, b.store.capture());
          assertEquals(
            JSON.parse(Deno.readTextFileSync(b.store.filename)),
            next(2),
          );
          assertEquals(events, [
            { kind: "directory", file: root },
            { kind: "directory", file: root },
            { kind: "file", file: candidate },
            {
              kind: existing ? "rename" : "link",
              file: b.store.filename,
              source: candidate,
            },
            { kind: "directory", file: root },
          ]);
          assert(!JSON.stringify(outcome).includes(secret));
          assert(!JSON.stringify(outcome).includes(root));
        });
      } finally {
        Deno.removeSync = remove;
        Deno.linkSync = link;
        Deno.renameSync = rename;
        logger.warning = warning;
      }
      assertEquals(storedDurabilityStatus().warningCount, count + 1);
      assertEquals(warnings.length, 1);
      assert(!JSON.stringify(warnings).includes(secret));
      assert(!JSON.stringify(warnings).includes(root));
      // Failed cleanup may retain only its own temporary hard-link alias, not a
      // false rollback or a reason to replay this committed mutation.
      b.owner.prepare(next(3), b.persistence, live().lease).publish();
      assertEquals(b.value, next(3));
      assertEquals(
        new IdentityFile(b.store.filename, validate, next(0)).capture().value,
        next(3),
      );
    }));
}

for (const failure of ["throw", "thenable"] as const) {
  Deno.test(`owned publication: installation ${failure} is committed recovery-required, not a durability warning or retry`, () =>
    fixture((root) => {
      const b = binding(
        root,
        (() => {
          if (failure === "throw") throw new Error(secret + root);
          return Promise.resolve();
        }) as unknown as (v: Value, s: StoredConfigSnapshot) => undefined,
      );
      const count = storedDurabilityStatus().warningCount;
      const first = b.owner.prepare(next(1), b.persistence, live().lease);
      const held = b.owner.prepare(next(2), b.persistence, live().lease);
      const outcome = first.publish();
      assertEquals(outcome.state, "recovery-required");
      assertEquals(outcome.committed, true);
      assertEquals(outcome.warning, null);
      assertEquals(storedDurabilityStatus().warningCount, count);
      assert(!JSON.stringify(outcome).includes(secret));
      assert(!JSON.stringify(outcome).includes(root));
      assertThrows(b.owner.assertAvailable, PublicationRecoveryRequired);
      assertThrows(
        () => b.owner.prepare(next(3), b.persistence, live().lease),
        PublicationRecoveryRequired,
      );
      assertThrows(() => held.publish(), PublicationRecoveryRequired);
      assertEquals(candidates(root), []);
      assertEquals(
        new IdentityFile(b.store.filename, validate, next(0)).capture().value,
        next(1),
      );
    }));
}

Deno.test("owned publication: async installer rejects before invocation or candidate allocation", () =>
  fixture((root) => {
    let entered = false;
    assertThrows(() =>
      binding(
        root,
        (async () => {
          entered = true;
          await Promise.resolve();
        }) as unknown as (v: Value, s: StoredConfigSnapshot) => undefined,
      ), TypeError);
    assertEquals(entered, false);
    assertEquals([...Deno.readDirSync(root)], []);
  }));

Deno.test("owned publication: untyped missing installer rejects before any allocation", () =>
  fixture((root) => {
    const store = new BoundFileStore(`${root}/record.json`);
    assertThrows(
      () => createOwnedPublication<Value>(store, undefined as never),
      TypeError,
    );
    assertThrows(
      () =>
        prepareStoredPublication(
          store,
          "{}",
          store.capture(),
          live().lease,
          undefined as never,
        ),
      TypeError,
    );
    assertEquals([...Deno.readDirSync(root)], []);
  }));

Deno.test("owned publication: notification sees installed exact state and cannot erase the committed result", () =>
  fixture((root) => {
    let seen = 0;
    const b = binding(root, undefined, () => {
      assertEquals(b.value, next(1));
      assertEquals(b.persistence, b.store.capture());
      seen++;
      throw new Error(secret + root);
    });
    const outcome = b.owner.prepare(next(1), b.persistence, live().lease)
      .publish();
    assertEquals(seen, 1);
    assertEquals(outcome.state, "committed");
    assertEquals(outcome.warning, null);
    assertEquals(outcome.notificationFailed, true);
    assert(!JSON.stringify(outcome).includes(secret));
    b.owner.assertAvailable();
  }));

Deno.test("owned publication pilot: final captured caller guard fences retirement during candidate preparation", () =>
  fixture((root) => {
    const file = new IdentityFile(`${root}/record.json`, validate, next(0));
    const before = file.capture(), write = Deno.writeTextFileSync;
    let retired = false;
    try {
      Deno.writeTextFileSync = ((name, data, options) => {
        write(name, data, options);
        retired = true;
      }) as typeof write;
      assertThrows(() =>
        file.commit(next(1), before, () => {
          if (retired) throw new Error("retired");
        })
      );
    } finally {
      Deno.writeTextFileSync = write;
    }
    assertStrictEquals(file.capture(), before);
    assertEquals(new BoundFileStore(`${root}/record.json`).capture().raw, null);
    assertEquals(candidates(root), []);
    file.commit(next(2));
    assertEquals(
      new IdentityFile(`${root}/record.json`, validate, next(0)).capture()
        .value,
      next(2),
    );
  }));

Deno.test("owned publication: exact committed outcome survives its own live-lease retirement", () =>
  fixture((root) => {
    const store = new BoundFileStore(`${root}/record.json`), operation = live();
    let installed: StoredConfigSnapshot | undefined;
    const owner = createOwnedPublication<Value>(store, (_value, snapshot) => {
      installed = snapshot;
      operation.retire();
      return undefined;
    });
    const outcome = owner.prepare(next(1), store.capture(), operation.lease)
      .publish();
    assertEquals(outcome.state, "committed");
    assertStrictEquals(outcome.operation, operation.lease.identity);
    assertEquals(installed, store.capture());
    assertThrows(() => owner.prepare(next(2), installed!, operation.lease));
  }));

Deno.test("owned publication pilot: validated immutable input is captured before any caller witness can reenter", () =>
  fixture((root) => {
    const file = new IdentityFile(`${root}/record.json`, validate, next(0));
    const input = next(1);
    file.commit(input, file.capture(), () => {
      input.revision = 99;
    });
    assertEquals(file.capture().value, next(1));
    assertEquals(
      new IdentityFile(`${root}/record.json`, validate, next(0)).capture()
        .value,
      next(1),
    );
  }));

Deno.test("owned publication: failed unpublished cleanup retains the exact primary and candidate custody", () =>
  fixture((root) => {
    const b = binding(root),
      primary = new Error("unpublished primary"),
      cleanup = new Error("cleanup primary");
    const prepared = b.owner.prepare(next(1), b.persistence, live().lease);
    const link = Deno.linkSync, remove = Deno.removeSync;
    try {
      Deno.linkSync = () => {
        throw primary;
      };
      Deno.removeSync = () => {
        throw cleanup;
      };
      const error = assertThrows(() => prepared.publish(), AggregateError);
      assertStrictEquals(error.cause, primary);
      assertEquals(error.errors.length, 2);
      assertStrictEquals(error.errors[0], primary);
      assertStrictEquals(error.errors[1], cleanup);
      assertEquals(candidates(root).length, 1);
      assertEquals(b.store.capture().raw, null);
    } finally {
      Deno.linkSync = link;
      Deno.removeSync = remove;
    }
    prepared.discard();
    assertEquals(candidates(root), []);
  }));

Deno.test("owned publication pilot: installation failure fences IdentityFile until explicit reopen, never a durability warning", () =>
  fixture((root) => {
    const filename = `${root}/record.json`,
      file = new IdentityFile(filename, validate, next(0));
    const freeze = Object.freeze,
      link = Deno.linkSync,
      count = storedDurabilityStatus().warningCount;
    let published = false;
    try {
      Deno.linkSync = (from, to) => {
        link(from, to);
        published = true;
      };
      Object.freeze = ((value: unknown) => {
        if (published && (value as { value?: Value })?.value?.revision === 1) {
          throw new Error(secret + root);
        }
        return freeze(value);
      }) as typeof freeze;
      const error = assertThrows(
        () => file.commit(next(1)),
        PublicationRecoveryRequired,
      );
      assertEquals(error.outcome.state, "recovery-required");
      assertEquals(error.outcome.committed, true);
      assert(!error.message.includes(secret));
    } finally {
      Object.freeze = freeze;
      Deno.linkSync = link;
    }
    assertEquals(storedDurabilityStatus().warningCount, count);
    assertThrows(() => file.capture(), PublicationRecoveryRequired);
    assertThrows(() => file.commit(next(2)), PublicationRecoveryRequired);
    assertEquals(
      new IdentityFile(filename, validate, next(0)).capture().value,
      next(1),
    );
  }));

Deno.test("owned publication: installation failure fences reads before durability-warning observers can reenter", () =>
  fixture((root) => {
    const b = binding(root, () => {
      throw new Error(secret);
    });
    const link = Deno.linkSync, warning = logger.warning;
    let blocked = false;
    try {
      logger.warning = () => {
        try {
          b.owner.assertAvailable();
        } catch (error) {
          blocked = error instanceof PublicationRecoveryRequired;
        }
      };
      observeDurability((_events, deny) => {
        const observedLink = Deno.linkSync;
        Deno.linkSync = (from, to) => {
          observedLink(from, to);
          deny(root);
        };
        const outcome = b.owner.prepare(next(1), b.persistence, live().lease)
          .publish();
        assertEquals(outcome.state, "recovery-required");
        assertEquals(outcome.warning, "stored-durability-unconfirmed");
      });
    } finally {
      Deno.linkSync = link;
      logger.warning = warning;
    }
    assertEquals(blocked, true);
    assertEquals(
      new IdentityFile(b.store.filename, validate, next(0)).capture().value,
      next(1),
    );
  }));
