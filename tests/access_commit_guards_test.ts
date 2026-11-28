// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { OperationError } from "../server/plugins/errors.ts";
import { settingsWriteGuard } from "../server/auth/middleware.ts";
import { canonicalScopes } from "../server/plugins/network_contracts.ts";
import {
  type NetworkOwner,
  PluginNetworkStore,
} from "../server/plugins/network_store.ts";
import brandHandler from "../server/api/endpoints/_/api/brand/post.ts";
import { accountRouteFixture } from "./helpers/account_route_fixture.ts";
import { bounded } from "./helpers/worker_liveness.ts";

const brand = '[brand]\nname="Original guarded brand"\naccent="#aabbcc"\n';
const stale =
  "Access policy changed while this operation was pending; it was not applied.";

function barrier() {
  let arrived!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, release, reached, waiting };
}

Deno.test("access commit: admitted Branding upload/removal cannot change files after Admin demotion", async () => {
  await accountRouteFixture(
    async ({ config, lifecycle, identity, alice, demoteAdmin }) => {
      const directory = `${config.statePath}/brand`;
      await Deno.mkdir(directory);
      const originalLogo =
          '<svg xmlns="http://www.w3.org/2000/svg" id="original-logo"/>',
        originalIcon =
          '<svg xmlns="http://www.w3.org/2000/svg" id="original-icon"/>';
      await Deno.writeTextFile(`${directory}/logo.svg`, originalLogo);
      await Deno.writeTextFile(`${directory}/icon.svg`, originalIcon);
      const form = new FormData();
      form.append("name", "must not replace guarded brand");
      form.append("accent", "#112233");
      form.append("removeIcon", "true");
      form.append(
        "logo",
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg" id="blocked-upload"/>'],
          "logo.svg",
          { type: "image/svg+xml" },
        ),
      );
      const raw = new Request("http://fixture/_/api/brand", {
        method: "POST",
        body: form,
        headers: { authorization: `Bearer ${(await alice()).access_token}` },
      });
      const hold = barrier();
      // Actual endpoint owns guard admission; this adapter only observes its
      // subsequent body await and releases the real platform multipart parser.
      const request = {
        _raw: raw,
        body: {
          form: async () => {
            hold.arrived();
            await hold.waiting;
            return raw.formData();
          },
        },
      } as unknown as PathfinderRequest;
      const rejected = assertRejects(
        () => brandHandler(request),
        OperationError,
        stale,
      );
      const epoch = lifecycle.epoch;
      let lockedBytes;
      try {
        await bounded(hold.reached, "branding multipart admission");
        lockedBytes = demoteAdmin();
      } finally {
        hold.release();
        const error = await rejected;
        assertEquals([error.status, error.code], [409, "operation_conflict"]);
      }
      assertEquals(identity.acl.capture().persistence.raw, lockedBytes);
      assertEquals(
        Deno.readTextFileSync(`${config.statePath}/config.toml`),
        brand,
      );
      assertEquals(
        (await assertRejects(
          () => settingsWriteGuard(raw),
          HttpError,
          "HTTP 403",
        )).status,
        403,
      );
      assertEquals(config.brandName, "Original guarded brand");
      assertEquals(config.brandAccent, "#aabbcc");
      assertEquals(
        await Deno.readTextFile(`${directory}/logo.svg`),
        originalLogo,
      );
      assertEquals(
        await Deno.readTextFile(`${directory}/icon.svg`),
        originalIcon,
      );
      assertEquals(
        [...Deno.readDirSync(directory)].map((entry) => entry.name).sort(),
        ["icon.svg", "logo.svg"],
      );
      assertEquals(lifecycle.epoch, epoch);
      assert(lifecycle.writable());
      assertEquals(
        (await identity.composition.auth.capabilities(raw)).canEdit,
        true,
      );
    },
    { brand },
  );
});

Deno.test("access commit: prepared operator approval and real pending-request decision retain exact ledger after lock", async (t) => {
  for (const kind of ["approval", "decision"] as const) {
    await t.step(kind, async () => {
      await accountRouteFixture(
        async ({ config, lifecycle, identity, alice, demoteAdmin }) => {
          const hold = barrier();
          let paused = false, committedWrites = 0;
          const scope = canonicalScopes(["127.0.0.1:9"]);
          const owner: NetworkOwner = {
            id: "guarded",
            source: () =>
              Promise.resolve({
                key: "a".repeat(64),
                codeFingerprint: "b".repeat(64),
                settingsRevision: 0,
              }),
            staticRequests: () => ({ network: scope, imports: [] }),
          };
          const store = new PluginNetworkStore(config.statePath, {
            commit: async (effect) => {
              if (paused) {
                hold.arrived();
                await hold.waiting;
              }
              return lifecycle.gate.run(effect);
            },
            committed: () => {
              committedWrites++;
            },
          });
          const synchronized = await store.synchronize(owner);
          const publication = await store.requestAccess(
            owner,
            synchronized.source,
            () => true,
            {
              kind: "network",
              hosts: ["127.0.0.1:9"],
              reason: "Actual pending guard decision",
            },
          );
          const before = await store.read(owner.id),
            callbacksBefore = committedWrites;
          const request = new Request(
            "http://fixture/_/api/plugin-host/guarded/permissions",
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${(await alice()).access_token}`,
              },
            },
          );
          const guard = await settingsWriteGuard(request);
          const payload = {
            revision: before.record.revision,
            signature: before.signature,
            requestSourceKey: synchronized.source.key,
            requestSourceRevision: synchronized.source.revision,
            allowNetwork: true,
            approvedNetwork: scope,
            approvedImports: [],
            ...(kind === "decision" ? { decision: "approve" } : {}),
          };
          paused = true;
          const pending = store.controls(
            owner,
            synchronized.source,
            payload,
            kind === "decision" ? { requestId: publication.value } : undefined,
            guard,
          );
          const rejected = assertRejects(() => pending, OperationError, stale);
          const epoch = lifecycle.epoch;
          let lockedBytes;
          try {
            await bounded(hold.reached, "prepared permission commit");
            lockedBytes = demoteAdmin();
          } finally {
            paused = false;
            hold.release();
            const error = await rejected;
            assertEquals([error.status, error.code], [
              409,
              "operation_conflict",
            ]);
          }
          const after = await store.read(owner.id);
          assertEquals(after.raw, before.raw);
          assertEquals(after.record, before.record);
          assertEquals(after.record.allowNetwork, false);
          assertEquals(after.record.approvedNetwork, []);
          assertEquals(
            after.record.requests.find((request) =>
              request.id === publication.value
            )?.state,
            "pending",
          );
          assertEquals(committedWrites, callbacksBefore);
          assertEquals(identity.acl.capture().persistence.raw, lockedBytes);
          assertEquals(
            (await assertRejects(
              () => settingsWriteGuard(request),
              HttpError,
              "HTTP 403",
            )).status,
            403,
          );
          assertEquals(lifecycle.epoch, epoch);
          assert(lifecycle.writable());
          assertEquals(
            [...Deno.readDirSync(`${config.statePath}/plugin-network`)].map(
              (entry) => entry.name,
            ),
            ["guarded.json"],
          );
          assertEquals(
            (await identity.composition.auth.capabilities(request)).canEdit,
            true,
          );
        },
      );
    });
  }
});
