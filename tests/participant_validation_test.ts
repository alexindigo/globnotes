// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { IdentityFile, type IdentitySnapshot } from "../server/auth/records.ts";
import { authorityRead } from "../server/auth/internal/authority_read.ts";
import { createOperationLease } from "../server/operation_lease.ts";
import { createPublicationSet } from "../server/config/owned_publication.ts";
import { PublicationSetUnavailable } from "../server/config/publication_outcome.ts";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import { assertPrivateModule } from "./helpers/credential_registration.ts";
import {
  AUTHORITY_READ,
  PUBLICATION_OWNERSHIP,
  PUBLICATION_VALIDATION,
} from "./helpers/ownership_rules.ts";
import { OwnershipError } from "../shared/ownership.js";

const SET = "00000000-0000-4000-8000-000000000071";
const OTHER = "00000000-0000-4000-8000-000000000072";
const unavailable =
  "Publication set is unavailable; settlement or recovery is required.";
function fixture(run: (root: string, scope: FixtureScope) => void) {
  return fixtureScope(async (scope) => {
    const root = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "participant-validation-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    await scope.admit(() => run(root.value, scope));
  });
}
Deno.test("participant validation: private native reads retain committed state, public and reentrant checks stay fenced", () =>
  fixture((root, scope) => {
    const a = new IdentityFile(
      `${root}/a.json`,
      (v) => v as { n: number },
      { n: 0 },
      undefined,
      root,
    );
    const b = new IdentityFile(
      `${root}/b.json`,
      (v) => v as { n: number },
      { n: 0 },
      undefined,
      root,
    );
    const before = a.capture();
    let probing = false;
    let checks = 0;
    let retained: object | undefined;
    const operation = createOperationLease("live", [(_id, context) => {
      const snapshot = authorityRead<IdentitySnapshot<{ n: number }>>(
        a,
        context,
      );
      assertEquals(snapshot, before);
      if (retained && retained !== context) {
        assertThrows(
          () => authorityRead(a, retained),
          PublicationSetUnavailable,
          unavailable,
        );
      }
      retained = context;
      if (probing) {
        checks++;
        assertThrows(() => a.capture(), PublicationSetUnavailable, unavailable);
        assertThrows(
          () => operation.lease.assertCurrent(),
          PublicationSetUnavailable,
          unavailable,
        );
      }
      return undefined;
    }]);
    scope.defer(() => operation.retire());
    probing = true;
    const first = a.prepareParticipant(
      { n: 1 },
      before,
      operation.lease,
      SET,
      "first",
    );
    scope.defer(() => first.discard());
    assertThrows(
      () => authorityRead(a, retained),
      PublicationSetUnavailable,
      unavailable,
    );
    const second = b.prepareParticipant(
      { n: 1 },
      b.capture(),
      operation.lease,
      SET,
      "second",
    );
    scope.defer(() => second.discard());
    const set = createPublicationSet(
      SET,
      [first, second],
      `${root}/journal.json`,
    );
    try {
      const other = new IdentityFile(
        `${root}/other.json`,
        (v) => v,
        {},
        undefined,
        root,
      );
      assertThrows(
        () =>
          other.prepareParticipant(
            {},
            other.capture(),
            operation.lease,
            SET,
            "other",
          ),
        PublicationSetUnavailable,
        unavailable,
      );
      assertThrows(
        () => operation.lease.assertCurrent(),
        PublicationSetUnavailable,
        unavailable,
      );
      set.decide();
      assertEquals(set.publish().state, "committed");
      assertThrows(() => a.capture(), PublicationSetUnavailable, unavailable);
      set.release();
      assertEquals([a.capture().value, b.capture().value], [{ n: 1 }, {
        n: 1,
      }]);
      assertEquals(checks > 4, true);
    } finally {
      set.discard();
      operation.retire();
    }
  }));

Deno.test("participant validation: another reservation cannot borrow a held peer and retired authority refuses preparation", () =>
  fixture((root) => {
    const a = new IdentityFile(`${root}/a.json`, (v) => v, {}, undefined, root);
    const b = new IdentityFile(`${root}/b.json`, (v) => v, {}, undefined, root);
    const operation = createOperationLease("live", [(_id, context) => {
      authorityRead(a, context);
      return undefined;
    }]);
    const first = a.prepareParticipant(
      {},
      a.capture(),
      operation.lease,
      SET,
      "first",
    );
    try {
      assertThrows(
        () =>
          b.prepareParticipant(
            {},
            b.capture(),
            operation.lease,
            OTHER,
            "second",
          ),
        PublicationSetUnavailable,
        unavailable,
      );
      operation.retire();
      assertThrows(
        () =>
          b.prepareParticipant({}, b.capture(), operation.lease, SET, "second"),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      first.discard();
      operation.retire();
    }
    assertEquals(a.capture().value, {});
  }));

Deno.test("participant validation registration: native contexts and authority readers are private", () => {
  for (const module of [PUBLICATION_VALIDATION, AUTHORITY_READ]) {
    assertPrivateModule(module, PUBLICATION_OWNERSHIP);
  }
});
