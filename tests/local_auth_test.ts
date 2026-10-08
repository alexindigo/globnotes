// SPDX-License-Identifier: LGPL-3.0-only

/** Unit tests for LocalAuth: JWT lifecycle, TOTP single-use, expiry.
 * Env vars are read at construction time, so each test sets its own. */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeBase32 } from "@std/encoding/base32";
import { SignJWT } from "jose";
import { LocalAuth, totpSecretFromRawKey } from "../server/auth/local.ts";
import { GlobalConfig } from "../server/config.ts";
import { authenticatorCode } from "./helpers/totp.ts";

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

Deno.test("LocalAuth: expiry metadata shares verification and preserves no-expiry tokens", async () => {
  const env = {
    GLOBNOTES_AUTH_TYPE: "password",
    GLOBNOTES_USERNAME: "alice",
    GLOBNOTES_PASSWORD: "secret",
    GLOBNOTES_SECRET_KEY: "testsecret",
  };
  const auth = authFor(await makeConfig(env), env);
  const expiry = Math.floor(Date.now() / 1000) + 60;
  const sign = (subject: string, expiration?: number, key = "testsecret") => {
    const jwt = new SignJWT({ sub: subject }).setProtectedHeader({
      alg: "HS256",
    });
    return (expiration === undefined ? jwt : jwt.setExpirationTime(expiration))
      .sign(new TextEncoder().encode(key));
  };
  const expiring = await sign("ALICE", expiry);
  assertEquals(await auth.validateTokenMetadata(expiring), {
    expiresAt: expiry * 1000,
  });
  assertEquals(await auth.validateToken(expiring), undefined);
  const unlimited = await sign("alice");
  assertEquals(await auth.validateTokenMetadata(unlimited), {
    expiresAt: null,
  });
  await auth.validateToken(unlimited);
  await assertRejects(async () =>
    auth.validateTokenMetadata(await sign("mallory"))
  );
  await assertRejects(async () =>
    auth.validateTokenMetadata(await sign("alice", expiry, "wrong-key"))
  );
  await assertRejects(async () =>
    auth.validateTokenMetadata(
      await sign("alice", Math.floor(Date.now() / 1000) - 1),
    )
  );
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

  // The client sends password + code concatenated. Codes are generated
  // independently from the QR secret, with its base32-decoded bytes.
  const secret = encodeBase32(new TextEncoder().encode(totpKey))
    .replace(/=+$/, "");
  const stepMs = 30_000;
  const now = Date.now();
  const codeAt = (epochMs: number) => authenticatorCode(secret, epochMs);
  const code = await codeAt(now);
  const prevCode = await codeAt(now - stepMs);
  const nextCode = await codeAt(now + stepMs);

  // Current step, previous step, next step — all accepted (window ±1:
  // clock skew and slow typing are not wrong credentials). The replay
  // check follows immediately: lastUsedTotp guards the double-submit.
  for (const c of [code, prevCode, nextCode]) {
    const token = await auth.login({
      username: "alice",
      password: `secret${c}`,
    });
    assert(typeof token.access_token === "string");
    // Same code right away → rejected (single-use, on the accepted code).
    await assertRejects(() =>
      auth.login({ username: "alice", password: `secret${c}` })
    );
  }

  // A code outside the window, and password alone → rejected.
  const farCode = await codeAt(now - 10 * stepMs);
  await assertRejects(() =>
    auth.login({ username: "alice", password: `secret${farCode}` })
  );
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

Deno.test("LocalAuth: wizard-enrolled TOTP (stored key + password hash)", async () => {
  // Post-setup state with NO env vars: config.json holds the hash and
  // the wizard-minted totp_key — the login path must behave exactly as
  // if TOTP had been env-configured.
  const totpKey = "wizard-minted-key";
  const vault = await Deno.makeTempDir();
  const { hashPassword } = await import("../server/helpers.ts");
  await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
  await Deno.writeTextFile(
    `${vault}/.globnotes/config.json`,
    JSON.stringify({
      auth_type: "totp",
      username: "dave",
      password_hash: await hashPassword("hunter2"),
      secret_key: "storedsecret",
      totp_key: totpKey,
    }),
  );
  for (
    const k of [
      "GLOBNOTES_USERNAME",
      "GLOBNOTES_PASSWORD",
      "GLOBNOTES_SECRET_KEY",
      "GLOBNOTES_AUTH_TYPE",
      "GLOBNOTES_TOTP_KEY",
    ]
  ) {
    Deno.env.delete(k);
  }
  Deno.env.set("GLOBNOTES_PATH", vault);
  const auth = new LocalAuth(new GlobalConfig());
  assert(auth.isTotpEnabled);
  assert(!auth.totpKeyFromEnv);

  const secret = totpSecretFromRawKey(totpKey);
  const stepMs = 30_000;
  const now = Date.now();
  const codeAt = (epochMs: number) => authenticatorCode(secret, epochMs);

  // Current, previous, next — all accepted (window ±1), each single-use.
  for (const epoch of [now, now - stepMs, now + stepMs]) {
    const code = await codeAt(epoch);
    const token = await auth.login({
      username: "dave",
      password: `hunter2${code}`,
    });
    assert(typeof token.access_token === "string");
    await assertRejects(() =>
      auth.login({ username: "dave", password: `hunter2${code}` })
    );
  }

  // Wrong password with a valid code, and a valid password with a
  // far-window code — both rejected.
  const currentCode = await codeAt(Date.now());
  const farCode = await codeAt(Date.now() - 10 * stepMs);
  await assertRejects(() =>
    auth.login({ username: "dave", password: `nope${currentCode}` })
  );
  await assertRejects(() =>
    auth.login({
      username: "dave",
      password: `hunter2${farCode}`,
    })
  );
  await Deno.remove(vault, { recursive: true });
});
