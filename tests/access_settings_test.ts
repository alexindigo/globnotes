// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { GlobalConfig } from "../server/config.ts";
import { hashPassword } from "../server/helpers.ts";
import { bootServer } from "./helpers/boot.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { settingsWriteGuard } from "../server/auth/middleware.ts";
import { state } from "../server/state.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { PluginDataStore, PluginPolicyStore } from "../server/plugins/data.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { fixturePage } from "./helpers/plugin_fixture.ts";

async function retainedFailure(
  error: unknown,
  vault: string,
  pidInfo: unknown,
): Promise<never> {
  console.error(
    `ACCESS FAILURE: ${
      error instanceof Error ? error.stack : error
    }; retained vault ${vault}; ${JSON.stringify(pidInfo)}`,
  );
  // Preserve the owning test process/server on a failed integration, matching
  // continuation custody. No release marker or success exit is synthesized.
  await new Promise(() => {});
  throw error;
}

Deno.test("access: settings lock projection separates public notes from settings", async () => {
  const vault = await Deno.makeTempDir({ prefix: "access-lock-projection-" });
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_READ_ONLY_SETTINGS",
  ];
  const previous = keys.map((key) => Deno.env.get(key));
  let passed = false;
  try {
    for (const key of keys) Deno.env.delete(key);
    Deno.env.set("GLOBNOTES_PATH", vault);
    await Deno.mkdir(`${vault}/.globnotes`);
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "none", read_only_settings: true }),
    );
    const config = new GlobalConfig();
    assertEquals(config.authType, "none");
    assertEquals(config.setupRequired, false);
    assertEquals(config.settingsWritable, false);
    Deno.env.set("GLOBNOTES_READ_ONLY_SETTINGS", "false");
    assertEquals(new GlobalConfig().settingsWritable, true);
    Deno.env.delete("GLOBNOTES_READ_ONLY_SETTINGS");
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "none" }),
    );
    assertEquals(new GlobalConfig().settingsWritable, true);
    passed = true;
  } finally {
    keys.forEach((key, index) =>
      previous[index] === undefined
        ? Deno.env.delete(key)
        : Deno.env.set(key, previous[index]!)
    );
    if (passed) await Deno.remove(vault, { recursive: true });
    else console.error(`Retained failed projection fixture: ${vault}`);
  }
});

Deno.test("access: configured credentials and confirmed 2FA commit in place", async (t) => {
  const vault = await Deno.makeTempDir({ prefix: "access-in-place-" });
  await Deno.mkdir(`${vault}/.globnotes`);
  const original = {
    auth_type: "password",
    username: "ALICE",
    password_hash: await hashPassword("old-password"),
    secret_key: crypto.randomUUID(),
    brand_name: "Retained brand",
    future_option: { retained: true },
  };
  const file = `${vault}/.globnotes/config.json`;
  await Deno.writeTextFile(file, JSON.stringify(original));
  await Deno.writeTextFile(`${vault}/Seed.md`, "Seed content.\n");
  let server = await bootServer({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "",
    GLOBNOTES_USERNAME: "",
    GLOBNOTES_PASSWORD: "",
    GLOBNOTES_SECRET_KEY: "",
    GLOBNOTES_TOTP_KEY: "",
    GLOBNOTES_READ_ONLY_SETTINGS: "",
    GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
  }, { cwd: vault });
  const call = async (
    route: string,
    method = "GET",
    data?: unknown,
    token?: string,
  ) => {
    const response = await fetch(`${server.baseUrl}/_/api/${route}`, {
      method,
      headers: {
        ...(data !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const login = (password: string) =>
    call("token", "POST", { username: "alice", password });
  let token = (await login("old-password")).body.access_token;
  try {
    const initialBytes = await Deno.readTextFile(file);
    await t.step(
      "configured enrolment is authenticated and leaves the live session/config intact",
      async () => {
        assertEquals(
          (await call("access/totp-enrolment", "POST", {})).status,
          401,
        );
        assertEquals(
          (await call("setup/reset", "POST", {}, token)).status,
          409,
        );
        assertEquals(await Deno.readTextFile(file), initialBytes);
      },
    );
    const bundleResponse = await call("access/totp-enrolment", "POST", {
      username: "alice",
    }, token);
    assertEquals(bundleResponse.status, 200);
    const bundle = bundleResponse.body;
    assert(bundle.qr.startsWith("data:image/png;base64,"));
    assertEquals(await Deno.readTextFile(file), initialBytes);
    assertEquals(
      (await call("auth-check", "GET", undefined, token)).status,
      200,
    );
    const code = await authenticatorCode(bundle.secret, Date.now());
    const view = (await call("access", "GET", undefined, token)).body;
    const request = {
      mode: "password",
      totpEnabled: true,
      totpKey: bundle.key,
      totpCode: code,
      revision: view.revision,
      signature: view.signature,
      currentPassword: "old-password",
    };
    await t.step(
      "invalid new key proof and wrong fresh password cannot change credentials or sessions",
      async () => {
        const far = await authenticatorCode(
          bundle.secret,
          Date.now() - 300_000,
        );
        assertEquals(
          (await call("access", "PUT", { ...request, totpCode: far }, token))
            .status,
          400,
        );
        assertEquals(
          (await call(
            "access",
            "PUT",
            { ...request, currentPassword: "wrong" },
            token,
          )).status,
          401,
        );
        assertEquals(await Deno.readTextFile(file), initialBytes);
        assertEquals(
          (await call("auth-check", "GET", undefined, token)).status,
          200,
        );
      },
    );
    await t.step(
      "only confirmed 2FA persists and retires the old session without replacing the password hash",
      async () => {
        const result = await call("access", "PUT", request, token);
        assertEquals(result.status, 200);
        assertEquals(result.body.requiresLogin, true);
        assertEquals(
          (await call("auth-check", "GET", undefined, token)).status,
          401,
        );
        const saved = JSON.parse(await Deno.readTextFile(file));
        assertEquals(saved.username, original.username);
        assertEquals(saved.password_hash, original.password_hash);
        assertEquals(saved.brand_name, original.brand_name);
        assertEquals(saved.future_option, original.future_option);
        assertEquals(saved.auth_type, "totp");
        assertEquals(saved.totp_key, bundle.key);
        assert(saved.secret_key !== original.secret_key);
        assertEquals((await call("config")).body.setupRequired, false);
        assertEquals((await login("old-password")).status, 401);
        assertEquals((await login(`old-password${code}`)).status, 401);
      },
    );
    const previousCode = await authenticatorCode(
      bundle.secret,
      Date.now() - 30_000,
    );
    const totpLogin = await login(`old-password${previousCode}`);
    assertEquals(totpLogin.status, 200);
    token = totpLogin.body.access_token;
    await t.step(
      "existing 2FA requires a fresh current code even with a valid session",
      async () => {
        const current = (await call("access", "GET", undefined, token)).body;
        const bytes = await Deno.readTextFile(file);
        assertEquals(
          (await call("access", "PUT", {
            mode: "password",
            totpEnabled: false,
            revision: current.revision,
            signature: current.signature,
            currentPassword: "old-password",
          }, token)).status,
          401,
        );
        assertEquals(await Deno.readTextFile(file), bytes);
        assertEquals(
          (await call("auth-check", "GET", undefined, token)).status,
          200,
        );
        const nextCode = await authenticatorCode(
          bundle.secret,
          Date.now() + 30_000,
        );
        assertEquals(
          (await call("access", "PUT", {
            mode: "password",
            totpEnabled: false,
            revision: current.revision,
            signature: current.signature,
            currentPassword: "old-password",
            currentTotp: nextCode,
          }, token)).status,
          200,
        );
        assertEquals(
          (await call("auth-check", "GET", undefined, token)).status,
          401,
        );
        token = (await login("old-password")).body.access_token;
      },
    );
    await t.step(
      "a password change immediately invalidates sessions and consumes the new password",
      async () => {
        const current = (await call("access", "GET", undefined, token)).body;
        const change = {
          mode: "password",
          password: "new-password",
          revision: current.revision,
          signature: current.signature,
          currentPassword: "old-password",
        };
        assertEquals((await call("access", "PUT", change, token)).status, 200);
        assertEquals(
          (await call("auth-check", "GET", undefined, token)).status,
          401,
        );
        assertEquals((await login("old-password")).status, 401);
        const fresh = await login("new-password");
        assertEquals(fresh.status, 200);
        token = fresh.body.access_token;
        const bytes = await Deno.readTextFile(file);
        assertEquals(
          (await call("access", "PUT", {
            ...change,
            currentPassword: "new-password",
          }, token)).status,
          409,
        );
        assertEquals(await Deno.readTextFile(file), bytes);
      },
    );
    await t.step(
      "protected-to-public defaults to locked settings while real notes remain writable",
      async () => {
        const current = (await call("access", "GET", undefined, token)).body;
        assertEquals(
          (await call("access", "PUT", {
            mode: "none",
            revision: current.revision,
            signature: current.signature,
            currentPassword: "new-password",
          }, token)).status,
          200,
        );
        const config = (await call("config")).body;
        assertEquals(config.authType, "none");
        assertEquals(config.settingsWritable, false);
        assertEquals(config.setupRequired, false);
        assertEquals((await login("new-password")).status, 404);
        assertEquals(
          (await call("notes", "POST", {
            path: "Public",
            content: "Public write consumer\n",
          })).status,
          200,
        );
        assertEquals(
          await Deno.readTextFile(`${vault}/Public.md`),
          "Public write consumer\n",
        );
        assertEquals(
          (await call("notes/Public")).body.content,
          "Public write consumer\n",
        );
        const bytes = await Deno.readTextFile(file);
        for (
          const [route, method] of [
            ["brand", "POST"],
            ["plugin-host/policy", "PUT"],
            ["plugin-host/unknown/enabled", "PUT"],
            ["plugin-host/unknown/settings/page", "PUT"],
            ["plugin-host/unknown/permissions", "PUT"],
            [
              "plugin-host/unknown/permission-requests/request/decision",
              "POST",
            ],
            ["access", "PUT"],
            ["access/totp-enrolment", "POST"],
            ["setup/reset", "POST"],
          ]
        ) assertEquals((await call(route, method, {})).status, 403, route);
        assertEquals(
          (await call("setup", "POST", { mode: "none" })).status,
          409,
        );
        assertEquals(await Deno.readTextFile(file), bytes);
      },
    );
    await server.close();
    server = await bootServer({
      GLOBNOTES_PATH: vault,
      GLOBNOTES_AUTH_TYPE: "",
      GLOBNOTES_READ_ONLY_SETTINGS: "",
      GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
    }, { cwd: vault });
    await t.step(
      "restart sees the persisted settings lock and retained unrelated config",
      async () => {
        assertEquals((await call("config")).body.settingsWritable, false);
        assertEquals((await call("access", "PUT", {})).status, 403);
        assertEquals(
          (await call("notes/Public")).body.content,
          "Public write consumer\n",
        );
        assertEquals(
          JSON.parse(await Deno.readTextFile(file)).future_option,
          original.future_option,
        );
      },
    );
    await server.close();
    server = await bootServer({
      GLOBNOTES_PATH: vault,
      GLOBNOTES_AUTH_TYPE: "",
      GLOBNOTES_READ_ONLY_SETTINGS: "false",
      GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
    }, { cwd: vault });
    await t.step(
      "deployment false overrides the saved lock and restores real settings persistence",
      async () => {
        const projected = (await call("config")).body;
        assertEquals(projected.settingsWritable, true);
        assertEquals(projected.readOnlySettings, false);
        const access = (await call("access")).body;
        assertEquals(access.pinned.readOnlySettings, true);
        assertEquals(
          (await call("access", "PUT", {
            mode: "none",
            readOnlySettings: true,
            revision: access.revision,
            signature: access.signature,
          })).status,
          409,
        );
        const catalog = (await call("plugin-host")).body;
        const id = catalog.plugins[0].id;
        assertEquals(
          (await call(`plugin-host/${id}/enabled`, "PUT", {
            enabled: false,
            revision: catalog.policy.revision,
            signature: catalog.policy.signature,
          })).status,
          200,
        );
        assert(
          JSON.parse(
            await Deno.readTextFile(`${vault}/.globnotes/plugins.json`),
          ).disabled.includes(id),
        );
        assertEquals(
          JSON.parse(await Deno.readTextFile(file)).read_only_settings,
          true,
        );
      },
    );
    await server.close();
  } catch (error) {
    await retainedFailure(error, vault, { url: server.baseUrl });
  }
});

Deno.test("access: pinned signing authority cannot pretend to revoke sessions with an ineffective stored override", async () => {
  const vault = await Deno.makeTempDir({ prefix: "access-signing-pin-" });
  await Deno.mkdir(`${vault}/.globnotes`);
  const file = `${vault}/.globnotes/config.json`;
  await Deno.writeTextFile(
    file,
    JSON.stringify({
      auth_type: "password",
      username: "alice",
      password_hash: await hashPassword("current-password"),
      secret_key: crypto.randomUUID(),
    }),
  );
  const server = await bootServer({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "",
    GLOBNOTES_SECRET_KEY: "fixture-pinned-signing-key",
    GLOBNOTES_READ_ONLY_SETTINGS: "",
    GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
  }, { cwd: vault });
  try {
    const login = await fetch(`${server.baseUrl}/_/api/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "current-password" }),
    });
    assertEquals(login.status, 200);
    const token = (await login.json()).access_token;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const view = await fetch(`${server.baseUrl}/_/api/access`, { headers })
      .then((r) => r.json());
    const before = await Deno.readTextFile(file);
    const result = await fetch(`${server.baseUrl}/_/api/access`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        mode: "password",
        password: "new-password",
        currentPassword: "current-password",
        revision: view.revision,
        signature: view.signature,
      }),
    });
    assertEquals(result.status, 409);
    await result.body?.cancel();
    assertEquals(await Deno.readTextFile(file), before);
    const check = await fetch(`${server.baseUrl}/_/api/auth-check`, {
      headers,
    });
    assertEquals(check.status, 200);
    await check.body?.cancel();
    await server.close();
  } catch (error) {
    await retainedFailure(error, vault, { url: server.baseUrl });
  }
});

Deno.test("access: initial public default and explicit locked choice survive prefix and restart", async () => {
  for (const lock of [false, true]) {
    const vault = await Deno.makeTempDir({ prefix: "access-public-setup-" });
    const env = {
      GLOBNOTES_PATH: vault,
      GLOBNOTES_AUTH_TYPE: "",
      GLOBNOTES_PATH_PREFIX: "/notes",
      GLOBNOTES_READ_ONLY_SETTINGS: "",
      GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
    };
    const server = await bootServer(env, { cwd: vault });
    try {
      const response = await fetch(`${server.baseUrl}/notes/_/api/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "none",
          ...(lock ? { readOnlySettings: true } : {}),
        }),
      });
      assertEquals(response.status, 200);
      await response.body?.cancel();
      const projected = await fetch(`${server.baseUrl}/notes/_/api/config`)
        .then((r) => r.json());
      assertEquals(projected.settingsWritable, !lock);
      assertEquals(projected.readOnlySettings, lock);
      assertEquals(
        JSON.parse(await Deno.readTextFile(`${vault}/.globnotes/config.json`))
          .read_only_settings,
        lock,
      );
      await server.close();
    } catch (error) {
      await retainedFailure(error, vault, { url: server.baseUrl });
    }
  }
});

Deno.test("access: admitted settings writes recheck at commit without blocking private plugin data", async () => {
  const vault = await Deno.makeTempDir({ prefix: "access-commit-guard-" });
  const previousState = { ...state };
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_READ_ONLY_SETTINGS",
  ];
  const previous = keys.map((key) => Deno.env.get(key));
  try {
    for (const key of keys) Deno.env.delete(key);
    Deno.env.set("GLOBNOTES_PATH", vault);
    await Deno.mkdir(`${vault}/.globnotes`);
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "none" }),
    );
    const config = new GlobalConfig(), lifecycle = new PluginLifecycle(config);
    state.config = config;
    state.auth = null;
    state.lifecycle = lifecycle;
    const guard = await settingsWriteGuard(
      new Request("http://fixture/", { method: "PUT" }),
    );
    let reached!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = true;
    const store = new PluginDataStore(config.statePath, {
      commit: async (effect) => {
        if (hold) {
          reached();
          await suspended;
        }
        return lifecycle.gate.run(effect);
      },
    });
    const page = validateSettingsPages([fixturePage])[0];
    const owner = store.forPlugin("held", guard);
    const pending = owner.savePage(page, {
      message: "must not persist",
      protect: false,
      limit: 3,
    }, 0);
    const rejected = assertRejects(() => pending, HttpError);
    await arrived;
    config.saveStoredConfig({
      ...config.storedConfig,
      read_only_settings: true,
      access_revision: 1,
    });
    assertEquals(lifecycle.writable(), true);
    const epoch = lifecycle.epoch;
    hold = false;
    release();
    const rejectedError = await rejected;
    assertEquals(rejectedError.status, 403);
    assert(String(rejectedError.detail).includes("Settings are read-only"));
    assertEquals((await owner.page(page)).revision, 0);
    assertEquals((await owner.page(page)).values.message, "fixture");
    await owner.save({ livePrivateConsumer: 1 }, 0);
    assertEquals((await owner.load()).values.livePrivateConsumer, 1);
    assertEquals(lifecycle.epoch, epoch);

    config.saveStoredConfig({
      ...config.storedConfig,
      read_only_settings: false,
      access_revision: 2,
    });
    const policyGuard = await settingsWriteGuard(
      new Request("http://fixture/", { method: "PUT" }),
    );
    let policyReached!: () => void, policyRelease!: () => void;
    const policyArrived = new Promise<void>((resolve) => {
      policyReached = resolve;
    });
    const policyWait = new Promise<void>((resolve) => {
      policyRelease = resolve;
    });
    const policy = new PluginPolicyStore(config.statePath, {
      commit: async (effect) => {
        policyReached();
        await policyWait;
        return lifecycle.gate.run(effect);
      },
    });
    const before = await policy.read();
    const write = policy.setEnabled("held", true, before.metadata, policyGuard);
    const policyRejected = assertRejects(() => write, HttpError);
    await policyArrived;
    config.saveStoredConfig({
      ...config.storedConfig,
      read_only_settings: true,
      access_revision: 3,
    });
    policyRelease();
    const policyError = await policyRejected;
    assertEquals(policyError.status, 403);
    assert(String(policyError.detail).includes("Settings are read-only"));
    assertEquals((await policy.read()).metadata, before.metadata);
  } finally {
    Object.assign(state, previousState);
    keys.forEach((key, index) =>
      previous[index] === undefined
        ? Deno.env.delete(key)
        : Deno.env.set(key, previous[index]!)
    );
  }
});

Deno.test("access: external same-revision bytes cannot be overwritten and restart merges the deployment edit", async () => {
  const vault = await Deno.makeTempDir({ prefix: "access-external-cas-" });
  await Deno.mkdir(`${vault}/.globnotes`);
  const file = `${vault}/.globnotes/config.json`;
  const initial = {
    auth_type: "none",
    access_revision: 0,
    brand_name: "Original",
    unrelated: { retained: true },
  };
  await Deno.writeTextFile(file, JSON.stringify(initial));
  await Deno.writeTextFile(`${vault}/Seed.md`, "External CAS note consumer\n");
  const env = {
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "",
    GLOBNOTES_READ_ONLY_SETTINGS: "",
    GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
  };
  let server = await bootServer(env, { cwd: vault });
  const call = async (route: string, method = "GET", data?: unknown) => {
    const response = await fetch(`${server.baseUrl}/_/api/${route}`, {
      method,
      headers: data === undefined ? {} : { "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try {
    const view = (await call("access")).body;
    const originalBytes = await Deno.readTextFile(file);
    for (
      const malformed of [null, [], {
        mode: "none",
        revision: view.revision,
        signature: view.signature,
        unrecognized: true,
      }, {
        mode: "none",
        revision: view.revision,
        signature: view.signature,
        readOnlySettings: "false",
      }, {
        mode: "none",
        revision: view.revision,
        signature: view.signature,
        updateId: "not-an-id",
      }]
    ) {
      assertEquals((await call("access", "PUT", malformed)).status, 422);
      assertEquals(await Deno.readTextFile(file), originalBytes);
    }
    const external = {
      ...initial,
      brand_name: "Deployment edit",
      external_option: { retained: "outside writer" },
    };
    const externalBytes = JSON.stringify(external, null, 4) + "\n";
    await Deno.writeTextFile(file, externalBytes);
    assertEquals((await call("access")).status, 409);
    assertEquals(
      (await call("access", "PUT", {
        mode: "none",
        readOnlySettings: false,
        revision: view.revision,
        signature: view.signature,
      })).status,
      409,
    );
    assertEquals(await Deno.readTextFile(file), externalBytes);
    assertEquals(
      (await call("notes/Seed")).body.content,
      "External CAS note consumer\n",
    );
    await server.close();
    server = await bootServer(env, { cwd: vault });
    const fresh = (await call("access")).body;
    assertEquals(fresh.revision, 0);
    assert(fresh.signature !== view.signature);
    const id = crypto.randomUUID();
    assertEquals(
      (await call("access", "PUT", {
        mode: "none",
        readOnlySettings: false,
        revision: fresh.revision,
        signature: fresh.signature,
        updateId: id,
      })).status,
      200,
    );
    const persisted = JSON.parse(await Deno.readTextFile(file));
    assertEquals(persisted.brand_name, external.brand_name);
    assertEquals(persisted.unrelated, initial.unrelated);
    assertEquals(persisted.external_option, external.external_option);
    assertEquals(persisted.access_update_id, id);
    assertEquals(persisted.access_revision, 1);
    assertEquals(
      await Deno.readTextFile(`${vault}/Seed.md`),
      "External CAS note consumer\n",
    );
    console.log(JSON.stringify({
      externalSameRevisionRejected: true,
      externalBytesRetained: true,
      deploymentRestartMergedUnknownFields: true,
      noteConsumerUnchanged: true,
      revision: persisted.access_revision,
    }));
    await server.close();
  } catch (error) {
    await retainedFailure(error, vault, { url: server.baseUrl });
  }
});

Deno.test("access: competing same-CAS requests have one durable receipt and cannot erase another writer", async () => {
  const vault = await Deno.makeTempDir({ prefix: "access-competing-cas-" });
  await Deno.mkdir(`${vault}/.globnotes`);
  const file = `${vault}/.globnotes/config.json`;
  await Deno.writeTextFile(
    file,
    JSON.stringify({ auth_type: "none", unrelated: { retained: true } }),
  );
  await Deno.writeTextFile(`${vault}/Seed.md`, "Competing CAS note consumer\n");
  const server = await bootServer({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "",
    GLOBNOTES_READ_ONLY_SETTINGS: "",
    GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
  }, { cwd: vault });
  try {
    const view = await fetch(`${server.baseUrl}/_/api/access`, {
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.all(ids.map(async (updateId) => {
      const response = await fetch(`${server.baseUrl}/_/api/access`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "none",
          readOnlySettings: false,
          revision: view.revision,
          signature: view.signature,
          updateId,
        }),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    }));
    assertEquals(results.map((r) => r.status).sort((a, b) => a - b), [
      200,
      409,
    ]);
    const winner = results.findIndex((result) => result.status === 200);
    const disk = JSON.parse(await Deno.readTextFile(file));
    assertEquals(disk.access_revision, 1);
    assertEquals(disk.access_update_id, ids[winner]);
    assertEquals(disk.unrelated, { retained: true });
    assertEquals(results[winner].body.requiresLogin, false);
    const config = await fetch(`${server.baseUrl}/_/api/config`, {
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    assertEquals(config.accessRevision, 1);
    assertEquals(config.accessUpdateId, ids[winner]);
    assertEquals(config.settingsWritable, true);
    const note = await fetch(`${server.baseUrl}/_/api/notes/Seed`, {
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    assertEquals(note.content, "Competing CAS note consumer\n");
    assertEquals(await Deno.readTextFile(`${vault}/Seed.md`), note.content);
    console.log(
      JSON.stringify({
        competingRequests: 2,
        persistedWinners: 1,
        rejectedLosers: 1,
        receiptMatchesWinner: true,
        noteConsumerUnchanged: true,
      }),
    );
    await server.close();
  } catch (error) {
    await retainedFailure(error, vault, { url: server.baseUrl });
  }
});
