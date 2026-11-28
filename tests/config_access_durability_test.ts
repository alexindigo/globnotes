// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertFalse } from "@std/assert";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { accountRouteFixture } from "./helpers/account_route_fixture.ts";
import access from "../server/api/endpoints/_/api/access/put.ts";
import configGet from "../server/api/endpoints/_/api/config/get.ts";
import { logger } from "../server/logger.ts";
import { createUuid } from "../shared/uuid.ts";

Deno.test("access durability: committed ACL reaches readers and projects a redacted warning", () =>
  accountRouteFixture(async ({ config, identity, lifecycle, alice }) => {
    const auth = { authorization: `Bearer ${(await alice()).access_token}` };
    const { revision, signature, grants } = await identity.acl.view();
    const events: string[] = [];
    const unsubscribe = identity.composition.subscribe(() => {
      events.push(identity.acl.capture().value.everybody);
    });
    const open = Deno.openSync,
      rename = Deno.renameSync,
      warning = logger.warning;
    const warnings: unknown[][] = [];
    let published = false;
    const updateId = createUuid(), epoch = lifecycle.epoch;
    try {
      Deno.renameSync = (from, to) => {
        rename(from, to);
        if (String(to) === `${config.statePath}/access.json`) published = true;
      };
      Deno.openSync = (file, options) => {
        const handle = open(file, options), sync = handle.syncSync.bind(handle);
        handle.syncSync = () => {
          if (
            published && String(file) === config.statePath &&
            handle.statSync().isDirectory
          ) {
            throw new Error("private fixture payload must not leak");
          }
          sync();
        };
        return handle;
      };
      logger.warning = (...args) => {
        warnings.push(args);
      };
      const result = await access(
        {
          _raw: new Request("http://fixture/_/api/access", {
            method: "PUT",
            headers: auth,
            body: JSON.stringify({
              revision,
              signature,
              grants,
              updateId,
              everybody: "view",
            }),
          }),
        } as PathfinderRequest,
      );
      assertEquals(result.status, 200);
      assertEquals(await result.json(), {
        updateId,
        committed: true,
        capabilities: {
          canRead: true,
          canEdit: true,
          canManageVault: true,
          canManageOwnAccount: true,
          canCreateVault: true,
        },
      });
    } finally {
      Deno.openSync = open;
      Deno.renameSync = rename;
      logger.warning = warning;
      unsubscribe();
    }
    assertEquals([published, events, lifecycle.epoch, lifecycle.writable()], [
      true,
      ["view"],
      epoch,
      true,
    ]);
    assertEquals(warnings.length, 1);
    assertFalse(JSON.stringify(warnings).includes(config.statePath));
    assertFalse(JSON.stringify(warnings).includes("private fixture"));
    const disk = JSON.parse(
      Deno.readTextFileSync(`${config.statePath}/access.json`),
    );
    assertEquals(disk, identity.acl.capture().value);
    assertEquals([disk.everybody, disk.updateId], ["view", updateId]);
    const view = await (await configGet(
      {
        _raw: new Request("http://fixture/_/api/config"),
      } as PathfinderRequest,
    )).json();
    assertEquals([
      view.setupRequired,
      view.principal,
      view.capabilities.canRead,
      view.capabilities.canEdit,
    ], [false, { kind: "guest" }, true, false]);
    assertEquals(view.storageDurability.warning, true);
    assertEquals(view.storageDurability.warningCount > 0, true);
    assertFalse(
      JSON.stringify(view.storageDurability).includes(config.statePath),
    );
  }));
