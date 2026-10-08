// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { GlobalConfig } from "../server/config.ts";
import { state } from "../server/state.ts";
import { settingsWriteGuard } from "../server/auth/middleware.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { canonicalScopes } from "../server/plugins/network_contracts.ts";
import {
  type NetworkOwner,
  PluginNetworkStore,
} from "../server/plugins/network_store.ts";
import brandHandler from "../server/api/endpoints/_/api/brand/post.ts";

async function settingsFixture(
  label: string,
  run: (
    fixture: {
      vault: string;
      config: GlobalConfig;
      lifecycle: PluginLifecycle;
    },
  ) => Promise<void>,
) {
  const vault = await Deno.makeTempDir({ prefix: `access-final-${label}-` });
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_READ_ONLY_SETTINGS",
    "GLOBNOTES_BRAND_NAME",
    "GLOBNOTES_BRAND_ACCENT",
  ];
  const previousEnv = keys.map((key) => Deno.env.get(key)),
    previousState = { ...state };
  try {
    for (const key of keys) Deno.env.delete(key);
    Deno.env.set("GLOBNOTES_PATH", vault);
    await Deno.mkdir(`${vault}/.globnotes`);
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({
        auth_type: "none",
        access_revision: 0,
        brand_name: "Original guarded brand",
        brand_accent: "#aabbcc",
        unrelated_guard_fixture: { retained: true },
      }),
    );
    const config = new GlobalConfig(), lifecycle = new PluginLifecycle(config);
    state.config = config;
    state.auth = null;
    state.lifecycle = lifecycle;
    await run({ vault, config, lifecycle });
    console.log(
      JSON.stringify({
        fixture: label,
        vault,
        settingsGuardConsumerCompleted: true,
      }),
    );
  } catch (error) {
    console.error(
      `ACCESS COMMIT GUARD FAILURE: ${
        error instanceof Error ? error.stack : error
      }; retained ${vault}; PID ${Deno.pid}`,
    );
    await new Promise(() => {});
    throw error;
  } finally {
    for (const key of ["config", "auth", "lifecycle"]) {
      if (!Object.hasOwn(previousState, key)) {
        Reflect.deleteProperty(state, key);
      }
    }
    Object.assign(state, previousState);
    keys.forEach((key, index) =>
      previousEnv[index] === undefined
        ? Deno.env.delete(key)
        : Deno.env.set(key, previousEnv[index]!)
    );
  }
}

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

Deno.test("access commit: admitted Branding upload/removal cannot change real files after settings lock", async () => {
  await settingsFixture("branding", async ({ config, lifecycle }) => {
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
    const pending = brandHandler(request),
      rejected = assertRejects(() => pending, HttpError);
    await hold.reached;
    config.saveStoredConfig({
      ...config.storedConfig,
      read_only_settings: true,
      access_revision: 1,
    });
    const lockedBytes = config.storedConfigText(), epoch = lifecycle.epoch;
    hold.release();
    assertEquals((await rejected).status, 403);
    assertEquals(config.storedConfigText(), lockedBytes);
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
    console.log(
      JSON.stringify({
        admittedBrandingRejectedAtEffect: 403,
        configAfterLockUnchanged: true,
        oldLogoBytesRetained: true,
        removedIconBytesRetained: true,
        noteAuthorityUnchanged: true,
      }),
    );
  });
});

Deno.test("access commit: prepared operator approval and real pending-request decision retain exact ledger after lock", async (t) => {
  for (const kind of ["approval", "decision"] as const) {
    await t.step(kind, async () => {
      await settingsFixture(kind, async ({ config, lifecycle }) => {
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
        const guard = await settingsWriteGuard(
          new Request("http://fixture/_/api/plugin-host/guarded/permissions", {
            method: "PUT",
          }),
        );
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
        const rejected = assertRejects(() => pending, HttpError);
        await hold.reached;
        config.saveStoredConfig({
          ...config.storedConfig,
          read_only_settings: true,
          access_revision: 1,
        });
        const lockedBytes = config.storedConfigText(), epoch = lifecycle.epoch;
        paused = false;
        hold.release();
        assertEquals((await rejected).status, 403);
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
        assertEquals(config.storedConfigText(), lockedBytes);
        assertEquals(lifecycle.epoch, epoch);
        assert(lifecycle.writable());
        assertEquals(
          [...Deno.readDirSync(`${config.statePath}/plugin-network`)].map(
            (entry) => entry.name,
          ),
          ["guarded.json"],
        );
        console.log(JSON.stringify({
          kind,
          preparedOperatorMutationRejectedAtEffect: 403,
          exactLedgerBytesRetained: true,
          samePendingRequest: publication.value,
          addedGrants: 0,
          addedCommittedCallbacks: 0,
          noteAuthorityUnchanged: true,
        }));
      });
    });
  }
});
