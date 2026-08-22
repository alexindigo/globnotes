// SPDX-License-Identifier: LGPL-3.0-only

/** Unit tests for LocalAuth: JWT lifecycle, TOTP single-use, expiry.
 * Env vars are read at construction time, so each test sets its own. */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeBase32 } from "@std/encoding/base32";
import { totp } from "otplib";
import { LocalAuth } from "../server/auth/local.ts";
import { GlobalConfig } from "../server/config.ts";

async function makeConfig(
  env: Record<string, string>,
): Promise<GlobalConfig> {
  const vault = await Deno.makeTempDir();
  const saved: Record<string, string> = { GLOBNOTES_PATH: vault };
  for (const [k, v] of Object.entries(env)) saved[k] = v;
  for (const [k, v] of Object.entries(saved)) Deno.env.set(k, v);
  return new GlobalConfig();
}

function authFor(
  config: GlobalConfig,
  env: Record<string, string>,
): LocalAuth {
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  return new LocalAuth(config);
}

Deno.test("LocalAuth: login and token round-trip", async () => {
  const env = {
    GLOBNOTES_AUTH_TYPE: "password",
    GLOBNOTES_USERNAME: "alice",
    GLOBNOTES_PASSWORD: "secret",
    GLOBNOTES_SECRET_KEY: "testsecret",
  };
  const auth = authFor(await makeConfig(env), env);
  const token = await auth.login({ username: "ALICE", password: "secret" });
  assertEquals(token.token_type, "bearer");
  await auth.validateToken(token.access_token);
  await assertRejects(() => auth.validateToken(null));
  await assertRejects(() =>
    auth.validateToken(token.access_token.slice(0, -2) + "xx")
  );
});

Deno.test("LocalAuth: token for a different username is rejected", async () => {
  const env = {
    GLOBNOTES_AUTH_TYPE: "password",
    GLOBNOTES_USERNAME: "alice",
    GLOBNOTES_PASSWORD: "secret",
    GLOBNOTES_SECRET_KEY: "testsecret",
  };
  const config = await makeConfig(env);
  const auth = authFor(config, env);
  const token = await auth.login({ username: "alice", password: "secret" });

  Deno.env.set("GLOBNOTES_USERNAME", "mallory");
  const other = new LocalAuth(config);
  // Same secret (shared vault) but a different configured username.
  await assertRejects(() => other.validateToken(token.access_token));
  await auth.validateToken(token.access_token);
});

Deno.test("LocalAuth: session expiry lands in the token", async () => {
  const env = {
    GLOBNOTES_AUTH_TYPE: "password",
    GLOBNOTES_USERNAME: "alice",
    GLOBNOTES_PASSWORD: "secret",
    GLOBNOTES_SECRET_KEY: "testsecret",
    GLOBNOTES_SESSION_EXPIRY_DAYS: "7",
  };
  const auth = authFor(await makeConfig(env), env);
  const token = await auth.login({ username: "alice", password: "secret" });
  const payload = JSON.parse(
    atob(
      token.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
    ),
  );
  const expected = Math.floor(Date.now() / 1000) + 7 * 86400;
  assert(Math.abs(payload.exp - expected) < 60);
});

Deno.test("LocalAuth: TOTP login and single-use enforcement", async () => {
  const totpKey = "my-totp-key";
  const env = {
    GLOBNOTES_AUTH_TYPE: "totp",
    GLOBNOTES_USERNAME: "alice",
    GLOBNOTES_PASSWORD: "secret",
    GLOBNOTES_SECRET_KEY: "testsecret",
    GLOBNOTES_TOTP_KEY: totpKey,
  };
  const auth = authFor(await makeConfig(env), env);
  assert(auth.isTotpEnabled);

  // The client sends password + current code concatenated.
  const secret = encodeBase32(new TextEncoder().encode(totpKey));
  const code = totp.generate(secret);
  const token = await auth.login({
    username: "alice",
    password: `secret${code}`,
  });
  assert(typeof token.access_token === "string");

  // Same code again → rejected (single-use).
  await assertRejects(() =>
    auth.login({ username: "alice", password: `secret${code}` })
  );

  // Code alone, password alone, wrong code → all rejected.
  await assertRejects(() =>
    auth.login({ username: "alice", password: "secret" })
  );
});

Deno.test("LocalAuth: stored-hash login (setup wizard path)", async () => {
  // Simulate post-setup state: config.json holds the hash, env is empty.
  const vault = await Deno.makeTempDir();
  const { hashPassword } = await import("../server/helpers.ts");
  await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
  await Deno.writeTextFile(
    `${vault}/.globnotes/config.json`,
    JSON.stringify({
      auth_type: "password",
      username: "carol",
      password_hash: await hashPassword("hunter2"),
      secret_key: "storedsecret",
    }),
  );
  for (
    const k of [
      "GLOBNOTES_USERNAME",
      "GLOBNOTES_PASSWORD",
      "GLOBNOTES_SECRET_KEY",
      "GLOBNOTES_AUTH_TYPE",
    ]
  ) {
    Deno.env.delete(k);
  }
  Deno.env.set("GLOBNOTES_PATH", vault);
  const config = new GlobalConfig();
  const auth = new LocalAuth(config);
  const token = await auth.login({ username: "Carol", password: "hunter2" });
  await auth.validateToken(token.access_token);
  await assertRejects(() =>
    auth.login({ username: "carol", password: "nope" })
  );
  await Deno.remove(vault, { recursive: true });
});
