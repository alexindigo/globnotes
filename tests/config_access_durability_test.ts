// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { GlobalConfig } from "./helpers/config.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { accessView, updateAccess } from "../server/auth/access.ts";
import status from "../server/api/endpoints/_/api/config/get.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { state } from "../server/state.ts";
import { logger } from "../server/logger.ts";

Deno.test("config durability warning: published access policy reaches runtime and config status", async () => {
  const root = Deno.realPathSync(
    await Deno.makeTempDir({ prefix: "access-durability-" }),
  );
  const previous = { ...state },
    open = Deno.openSync,
    rename = Deno.renameSync,
    warning = logger.warning;
  let published = false, warned = false;
  let diagnostic = "";
  let suspended = 0, stopped = 0, reconciled = 0;
  try {
    Deno.mkdirSync(`${root}/.globnotes`);
    Deno.writeTextFileSync(
      `${root}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "none", access_revision: 0 }),
    );
    const config = new GlobalConfig(
      testEnvironment({ GLOBNOTES_GLOBNOTES_PATH: root }),
    );
    state.config = config;
    state.auth = null;
    state.plugins = {
      runtime: {
        suspend() {
          suspended++;
        },
        reconcile() {
          reconciled++;
        },
      },
      stop() {
        stopped++;
      },
    } as unknown as NonNullable<typeof state.plugins>;
    state.lifecycle = new PluginLifecycle(config);
    const before = await accessView();
    Deno.renameSync = (from, to) => {
      rename(from, to);
      published = true;
    };
    Deno.openSync = ((file, options) => {
      const handle = open(file, options), sync = handle.syncSync.bind(handle);
      handle.syncSync = () => {
        if (
          published && String(file) === `${root}/.globnotes` &&
          handle.statSync().isDirectory
        ) throw new Error("private fixture payload must not leak");
        sync();
      };
      return handle;
    }) as typeof open;
    logger.warning = (...args) => {
      warned = true;
      diagnostic = JSON.stringify(args);
    };
    await updateAccess(
      new Request("http://fixture/_/api/access", { method: "PUT" }),
      {
        mode: "read_only",
        revision: before.revision,
        signature: before.signature,
      },
    );
    assert(published);
    assert(warned);
    assert(!diagnostic.includes(root));
    assert(!diagnostic.includes("private fixture"));
    const disk = JSON.parse(
      Deno.readTextFileSync(`${root}/.globnotes/config.json`),
    );
    assertEquals(config.authType, disk.auth_type);
    assertEquals(config.settingsWritable, false);
    assertEquals(config.setupRequired, false);
    assertEquals(state.auth, null);
    assertEquals(state.lifecycle.epoch, 1);
    assertEquals([suspended, stopped, reconciled], [1, 1, 1]);
    const view = status();
    const durability = view.storageDurability as {
      warning: boolean;
      warningCount: number;
    };
    assertEquals(durability.warning, true);
    assert(durability.warningCount > 0);
    assert(!JSON.stringify(durability).includes(root));
  } finally {
    Deno.openSync = open;
    Deno.renameSync = rename;
    logger.warning = warning;
    Object.assign(state, previous);
    Deno.removeSync(root, { recursive: true });
  }
});
