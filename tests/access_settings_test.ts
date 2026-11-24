// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { OperationError } from "../server/plugins/errors.ts";
import { settingsWriteGuard } from "../server/auth/middleware.ts";
import { PluginDataStore, PluginPolicyStore } from "../server/plugins/data.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { fixturePage } from "./helpers/plugin_fixture.ts";
import { accountRouteFixture } from "./helpers/account_route_fixture.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import { createUuid } from "../shared/uuid.ts";

Deno.test("Access: guest Edit still writes notes but never changes settings; a named Admin can", () =>
  accountRouteFixture(async ({ alice, identity }) => {
    const guest = new Request("http://fixture/");
    assertEquals(await identity.composition.auth.capabilities(guest), {
      canRead: true,
      canEdit: true,
      canManageVault: false,
      canManageOwnAccount: false,
      canCreateVault: false,
    });
    assertEquals(
      (await assertRejects(
        () => settingsWriteGuard(guest),
        HttpError,
        "HTTP 403",
      )).status,
      403,
    );
    const { access_token } = await alice();
    assertEquals(
      (await identity.composition.auth.capabilities(
        new Request(guest, {
          headers: { authorization: `Bearer ${access_token}` },
        }),
      )).canManageVault,
      true,
    );
  }));

for (const kind of ["page", "policy"] as const) {
  Deno.test(`Access: held ${kind} write rechecks Admin without blocking plugin private data`, () =>
    accountRouteFixture(
      async ({ alice, config, lifecycle, demoteAdmin, scope }) => {
        const { access_token } = await alice();
        const request = new Request("http://fixture/", {
          method: "PUT",
          headers: { authorization: `Bearer ${access_token}` },
        });
        const guard = await settingsWriteGuard(request);
        const reached = fixtureGate(scope), release = fixtureGate(scope);
        let hold = true;
        const adapters = {
          commit: async <T>(effect: () => T | Promise<T>): Promise<T> => {
            if (hold) {
              reached.resolve();
              await release.promise;
            }
            return await lifecycle.gate.run(effect);
          },
        };
        const page = validateSettingsPages([fixturePage])[0];
        const owner = new PluginDataStore(config.statePath, adapters).forPlugin(
          "held",
          guard,
        );
        const policy = new PluginPolicyStore(config.statePath, adapters);
        const before = await policy.read(),
          pageBefore = await owner.page(page),
          epoch = lifecycle.epoch;
        const write = async () => {
          if (kind === "page") {
            await owner.savePage(page, {
              ...pageBefore.values,
              message: "must not persist",
            }, 0);
          } else await policy.setEnabled("held", true, before.metadata, guard);
        };
        const rejected = assertRejects(
          write,
          OperationError,
          "Access policy changed while this operation was pending; it was not applied.",
        );
        try {
          await bounded(reached.promise, `${kind} admission`);
          demoteAdmin();
        } finally {
          hold = false;
          release.resolve();
          assertEquals((await rejected).status, 409);
        }
        assertEquals(
          (await assertRejects(
            () => settingsWriteGuard(request),
            HttpError,
            "HTTP 403",
          )).status,
          403,
        );
        assertEquals(await owner.page(page), pageBefore);
        assertEquals((await policy.read()).metadata, before.metadata);
        await owner.save({ livePrivateConsumer: 1 }, 0);
        assertEquals(await owner.load(), {
          schemaVersion: 1,
          revision: 1,
          values: { livePrivateConsumer: 1 },
        });
        assertEquals([lifecycle.epoch, lifecycle.writable()], [epoch, true]);
      },
    ));
}

Deno.test("Access: competing updates from the same snapshot leave exactly one durable receipt", () =>
  accountRouteFixture(async ({ alice, identity, config }) => {
    const { principal } = await alice();
    const { revision, signature, grants } = await identity.acl.view();
    const ids = [createUuid(), createUuid()];
    const jobs = ids.map((updateId) =>
      identity.access.update(principal, {
        revision,
        signature,
        grants,
        updateId,
        everybody: "view",
      }).then((body) => new Response(body).json())
    );
    const outcomes = await Promise.allSettled(jobs);
    assertEquals(outcomes.map(({ status }) => status).sort(), [
      "fulfilled",
      "rejected",
    ]);
    const winner = outcomes.findIndex(({ status }) => status === "fulfilled");
    const loss = outcomes[1 - winner];
    if (loss.status !== "rejected") throw new Error("Missing stale request");
    assertEquals(
      loss.reason instanceof StoredConfigConflict ||
        loss.reason instanceof OperationError,
      true,
    );
    const disk = JSON.parse(
      Deno.readTextFileSync(`${config.statePath}/access.json`),
    );
    assertEquals([disk.revision, disk.updateId, disk.grants, disk.everybody], [
      revision + 1,
      ids[winner],
      grants,
      "view",
    ]);
    assertEquals(identity.acl.capture().value, disk);
  }));
