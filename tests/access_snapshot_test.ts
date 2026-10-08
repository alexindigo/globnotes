// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { GlobalConfig } from "../server/config.ts";
import { accessView, updateAccess } from "../server/auth/access.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { state } from "../server/state.ts";
import { hashPassword } from "../server/helpers.ts";
import { LocalAuth } from "../server/auth/local.ts";
import setupHandler from "../server/api/endpoints/_/api/setup/post.ts";
import brandHandler from "../server/api/endpoints/_/api/brand/post.ts";

async function accessSnapshotFixture() {
  const root = await Deno.makeTempDir({ prefix: "review-access-snapshot-" });
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_USERNAME",
    "GLOBNOTES_PASSWORD",
    "GLOBNOTES_TOTP_KEY",
    "GLOBNOTES_SECRET_KEY",
    "GLOBNOTES_READ_ONLY_SETTINGS",
  ];
  const previousEnv = keys.map((key) => Deno.env.get(key));
  const previousState = { ...state };
  for (const key of keys) Deno.env.delete(key);
  Deno.env.set("GLOBNOTES_PATH", root);
  await Deno.mkdir(`${root}/.globnotes`);
  const file = `${root}/.globnotes/config.json`;
  const initial = {
    auth_type: "none",
    read_only_settings: false,
    access_revision: 0,
    brand_name: "original",
    unrelated: { keep: true },
  };
  await Deno.writeTextFile(file, JSON.stringify(initial));
  const config = new GlobalConfig();
  state.config = config;
  state.auth = null;
  state.lifecycle = new PluginLifecycle(config);
  state.plugins = null;
  return {
    root,
    file,
    config,
    initial,
    request: () =>
      new Request("http://fixture/_/api/access", { method: "PUT" }),
    close() {
      Object.assign(state, previousState);
      keys.forEach((key, i) =>
        previousEnv[i] === undefined
          ? Deno.env.delete(key)
          : Deno.env.set(key, previousEnv[i]!)
      );
      console.log(JSON.stringify({ retainedAccessSnapshotFixture: root }));
    },
  };
}

Deno.test("review repairs: R05 non-string access modes reject before config memory revision or epoch effects", async (t) => {
  for (
    const mode of [
      ["none"],
      [["none"]],
      ["read_only"],
      {},
      null,
      1,
      true,
      undefined,
      "NONE",
      " none",
      "totp",
    ]
  ) {
    await t.step(JSON.stringify(mode) ?? "missing", async () => {
      const f = await accessSnapshotFixture();
      try {
        const before = await accessView(),
          bytes = await Deno.readTextFile(f.file),
          memory = structuredClone(f.config.storedConfig),
          epoch = state.lifecycle!.epoch;
        const result = await updateAccess(f.request(), {
          mode,
          revision: before.revision,
          signature: before.signature,
          readOnlySettings: false,
        }).then(
          () => 200,
          (error) => error instanceof HttpError ? error.status : 500,
        );
        console.log(
          JSON.stringify({
            invalidMode: mode ?? "missing/null",
            actualStatus: result,
            exactBytesRetained: await Deno.readTextFile(f.file) === bytes,
          }),
        );
        assertEquals(result, 422);
        assertEquals(await Deno.readTextFile(f.file), bytes);
        assertEquals(f.config.storedConfig, memory);
        assertEquals(state.lifecycle!.epoch, epoch);
        assertEquals(state.auth, null);
        assertEquals(new GlobalConfig().authType, f.config.authType);
      } finally {
        await f.close();
      }
    });
  }
});

for (const applicationEdit of [false, true]) {
  Deno.test(`review repairs: R06 ${applicationEdit ? "application" : "external"} edit during real config signature wait preserves newer bytes`, async () => {
    const f = await accessSnapshotFixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let held = false;
    let pending: Promise<{ status: number }> | undefined;
    try {
      const before = await accessView();
      crypto.subtle.digest =
        ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
          const actual = digest(algorithm, data);
          if (!held) {
            held = true;
            reached.resolve();
            return actual.then(async (value) => {
              await release.promise;
              return value;
            });
          }
          return actual;
        }) as typeof crypto.subtle.digest;
      pending = updateAccess(f.request(), {
        mode: "none",
        readOnlySettings: false,
        revision: before.revision,
        signature: before.signature,
      }).then(
        () => ({ status: 200 }),
        (error) => ({
          status: error instanceof HttpError ? error.status : 500,
        }),
      );
      await reached.promise;
      const newer = {
        ...f.initial,
        brand_name: "newer application/deployment edit",
        newer_option: { retained: true },
      };
      const bytes = JSON.stringify(newer, null, 4) + "\n";
      await Deno.writeTextFile(f.file, bytes);
      if (applicationEdit) f.config.storedConfig = newer;
      release.resolve();
      const result = await pending;
      console.log(
        JSON.stringify({
          applicationEdit,
          actualStatus: result.status,
          newerBytesRetained: await Deno.readTextFile(f.file) === bytes,
        }),
      );
      assertEquals(result.status, 409);
      assertEquals(await Deno.readTextFile(f.file), bytes);
      assertEquals(f.config.storedConfig, applicationEdit ? newer : f.initial);
      assertEquals(state.lifecycle!.epoch, 0);
      assert(
        !Object.keys(await accessView().catch(() => ({}))).includes("raw"),
      );
    } finally {
      release.resolve();
      crypto.subtle.digest = digest;
      if (pending) await pending;
      await f.close();
    }
  });
}

Deno.test("review repairs: R06 real current credential confirmation cannot overwrite a later config edit", async () => {
  const f = await accessSnapshotFixture(),
    reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending: Promise<number> | undefined;
  try {
    const account = {
      ...f.initial,
      auth_type: "password",
      username: "owner",
      password_hash: await hashPassword("fixture password"),
      secret_key: "fixture-only-signing-key",
    };
    f.config.saveStoredConfig(account);
    f.config.authType = new GlobalConfig().authType;
    const auth = new LocalAuth(f.config);
    state.auth = auth;
    const token =
      (await auth.login({ username: "owner", password: "fixture password" }))
        .access_token;
    const before = await accessView(),
      confirm = auth.confirmCredentials.bind(auth);
    auth.confirmCredentials = async (...args) => {
      await confirm(...args);
      reached.resolve();
      await release.promise;
    };
    try {
      pending = updateAccess(
        new Request("http://fixture/_/api/access", {
          method: "PUT",
          headers: { authorization: `Bearer ${token}` },
        }),
        {
          mode: "password",
          revision: before.revision,
          signature: before.signature,
          currentPassword: "fixture password",
        },
      ).then(
        () => 200,
        (error) => error instanceof HttpError ? error.status : 500,
      );
      await reached.promise;
      const bytes = JSON.stringify(
        {
          ...account,
          brand_name: "newer during confirmation",
          unknown_confirmation_option: true,
        },
        null,
        4,
      ) + "\n";
      Deno.writeTextFileSync(f.file, bytes);
      release.resolve();
      assertEquals(await pending, 409);
      assertEquals(Deno.readTextFileSync(f.file), bytes);
      assertEquals(f.config.storedConfig, account);
      assertEquals(state.auth, auth);
      assertEquals(state.lifecycle!.epoch, 0);
      await auth.validateToken(token);
      console.log(
        JSON.stringify({
          confirmationSnapshotConflict: 409,
          originalSessionStillValid: true,
          exactNewerBytesRetained: true,
        }),
      );
    } finally {
      release.resolve();
      auth.confirmCredentials = confirm;
      if (pending) await pending;
    }
  } finally {
    await f.close();
  }
});

Deno.test("review repairs: R06 setup carries original config through real password hashing", async () => {
  const f = await accessSnapshotFixture(),
    derive = crypto.subtle.deriveBits.bind(crypto.subtle),
    reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending: Promise<number> | undefined, held = false;
  try {
    const initial = { brand_name: "pending setup", unknown_setup_option: true };
    Deno.writeTextFileSync(f.file, JSON.stringify(initial));
    state.config = new GlobalConfig();
    state.lifecycle = new PluginLifecycle(state.config);
    crypto.subtle.deriveBits =
      ((...args: Parameters<typeof crypto.subtle.deriveBits>) => {
        const actual = derive(...args);
        if (!held) {
          held = true;
          reached.resolve();
          return actual.then(async (result) => {
            await release.promise;
            return result;
          });
        }
        return actual;
      }) as typeof crypto.subtle.deriveBits;
    pending = setupHandler(
      {
        body: {
          json: () =>
            Promise.resolve({
              mode: "password",
              username: "new owner",
              password: "fixture setup password",
            }),
        },
      } as unknown as PathfinderRequest,
    ).then(
      () => 200,
      (error) => error instanceof HttpError ? error.status : 500,
    );
    await reached.promise;
    const bytes = JSON.stringify(
      { ...initial, brand_name: "newer deployment setup option" },
      null,
      4,
    ) + "\n";
    Deno.writeTextFileSync(f.file, bytes);
    release.resolve();
    assertEquals(await pending, 409);
    assertEquals(Deno.readTextFileSync(f.file), bytes);
    assertEquals(state.config.storedConfig, initial);
    assertEquals(state.config.setupRequired, true);
    assertEquals(state.auth, null);
    assertEquals(state.lifecycle!.epoch, 0);
    console.log(
      JSON.stringify({
        setupHashConflict: 409,
        exactNewerBytesRetained: true,
        setupStillPending: true,
      }),
    );
  } finally {
    release.resolve();
    crypto.subtle.deriveBits = derive;
    if (pending) await pending;
    await f.close();
  }
});

Deno.test("review repairs: R06 branding preparation holds config snapshot before any image or merge effect", async () => {
  const f = await accessSnapshotFixture(),
    reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending: Promise<number> | undefined;
  try {
    const dir = `${f.root}/.globnotes/brand`, original = "original logo bytes";
    Deno.mkdirSync(dir);
    Deno.writeTextFileSync(`${dir}/logo.svg`, original);
    const form = new FormData();
    form.set("name", "stale brand proposal");
    form.set("logo", new File(["new image bytes"], "logo.svg"));
    const raw = new Request("http://fixture/_/api/brand", {
      method: "POST",
      body: form,
    });
    pending = brandHandler({
      _raw: raw,
      body: {
        form: async () => {
          reached.resolve();
          await release.promise;
          return raw.formData();
        },
      },
    } as unknown as PathfinderRequest).then(
      () => 200,
      (error) => error instanceof HttpError ? error.status : 500,
    );
    await reached.promise;
    const newer = { ...f.initial, brand_name: "newer application owner" },
      bytes = JSON.stringify(newer);
    Deno.writeTextFileSync(f.file, bytes);
    f.config.storedConfig = newer;
    release.resolve();
    assertEquals(await pending, 409);
    assertEquals(Deno.readTextFileSync(f.file), bytes);
    assertEquals(Deno.readTextFileSync(`${dir}/logo.svg`), original);
    assertEquals(f.config.brandName, "original");
    console.log(
      JSON.stringify({
        brandingPreparedConfigConflict: 409,
        originalImageRetained: true,
        exactNewerConfigRetained: true,
      }),
    );
  } finally {
    release.resolve();
    if (pending) await pending;
    await f.close();
  }
});
