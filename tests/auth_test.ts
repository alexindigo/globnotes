// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Integration tests for the setup wizard and auth flows — the Deno port
 * of tests/test_setup.py. Boots real server subprocesses against temp
 * vaults. Write-gating coverage lands with the notes/files endpoints
 * (commits 4–6); the Python suite's cases here are fully covered.
 */

import { assert, assertEquals } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

Deno.test("auth: setup mode", async (t) => {
  const server = await bootServer({});
  try {
    await t.step("setup status reports required", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/setup`);
      assertEquals(res.status, 200);
      assertEquals((await res.json()).setupRequired, true);
    });

    await t.step("config reports setup required", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/config`);
      const body = await res.json();
      assertEquals(body.setupRequired, true);
      assertEquals(body.authType, null);
    });

    await t.step("authed APIs return 503 until setup", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/auth-check`);
      assertEquals(res.status, 503);
      assertEquals((await res.json()).detail, "setup_required");
    });

    await t.step("public endpoints work during setup", async () => {
      const health = await fetch(`${server.baseUrl}/_/api/health`);
      assertEquals(health.status, 200);
      const token = await fetch(`${server.baseUrl}/_/api/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "x", password: "y" }),
      });
      // Python: route registered (auth_type unset) but no auth instance.
      assertEquals(token.status, 400);
      assertEquals(
        (await token.json()).detail,
        "Authentication is not enabled.",
      );
    });
  } finally {
    await server.close();
  }
});

Deno.test("auth: read_only flow", async (t) => {
  const server = await bootServer({});
  try {
    const setup = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "read_only" }),
    });
    assertEquals(setup.status, 200);
    assertEquals((await setup.json()).setupRequired, false);

    await t.step("reads work without a token", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/auth-check`);
      assertEquals(res.status, 200);
    });

    await t.step("token endpoint 404s in read-only", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "x", password: "y" }),
      });
      assertEquals(res.status, 404);
    });

    await t.step("the choice is persisted", async () => {
      const config = JSON.parse(
        await Deno.readTextFile(`${server.vault}/.globnotes/config.json`),
      );
      assertEquals(config.auth_type, "read_only");
    });
  } finally {
    await server.close();
  }

  await t.step("read_only persists across restart", async () => {
    const restarted = await bootServer({ GLOBNOTES_PATH: server.vault });
    try {
      const res = await fetch(`${restarted.baseUrl}/_/api/setup`);
      assertEquals((await res.json()).setupRequired, false);
      const check = await fetch(`${restarted.baseUrl}/_/api/auth-check`);
      assertEquals(check.status, 200);
    } finally {
      await restarted.close();
    }
    await Deno.remove(server.vault, { recursive: true });
  });
});

Deno.test("auth: disable-auth flow", async (t) => {
  const server = await bootServer({});
  try {
    const setup = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "none" }),
    });
    assertEquals(setup.status, 200);
    assertEquals((await setup.json()).setupRequired, false);

    await t.step("data APIs work immediately", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/auth-check`);
      assertEquals(res.status, 200);
    });

    await t.step("the choice is persisted", async () => {
      const config = JSON.parse(
        await Deno.readTextFile(`${server.vault}/.globnotes/config.json`),
      );
      assertEquals(config.auth_type, "none");
    });

    await t.step("setup cannot be repeated", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "none" }),
      });
      assertEquals(res.status, 409);
    });
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("auth: password flow", async (t) => {
  const server = await bootServer({});
  try {
    const setup = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "password",
        username: "Alice",
        password: "secret",
      }),
    });
    assertEquals(setup.status, 200);

    await t.step("data APIs now require a token", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/auth-check`);
      assertEquals(res.status, 401);
      assertEquals(
        res.headers.get("www-authenticate"),
        "Bearer",
      );
      assertEquals(
        (await res.json()).detail,
        "Invalid authentication credentials",
      );
    });

    let token = "";
    await t.step("login works, username lowercased", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "secret" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assert(typeof body.access_token === "string");
      assertEquals(body.token_type, "bearer");
      token = body.access_token;
    });

    await t.step("bearer token authenticates", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/auth-check`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), "OK");
    });

    await t.step("cookie token authenticates", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/auth-check`, {
        headers: { cookie: `token=${token}` },
      });
      assertEquals(res.status, 200);
    });

    await t.step("wrong password is rejected", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "wrong" }),
      });
      assertEquals(res.status, 401);
      assertEquals((await res.json()).detail, "Invalid login details.");
    });

    await t.step("stored password is hashed, not plaintext", async () => {
      const config = JSON.parse(
        await Deno.readTextFile(`${server.vault}/.globnotes/config.json`),
      );
      assert(config.password_hash.startsWith("pbkdf2_sha256$"));
      assert(!config.password_hash.includes("secret"));
      assertEquals(config.username, "alice");
      assert(typeof config.secret_key === "string");
      assertEquals(config.secret_key.length, 64);
    });
  } finally {
    await server.close();
  }

  await t.step("setup persists across restart", async () => {
    const restarted = await bootServer({ GLOBNOTES_PATH: server.vault });
    try {
      const res = await fetch(`${restarted.baseUrl}/_/api/setup`);
      assertEquals((await res.json()).setupRequired, false);
      const check = await fetch(`${restarted.baseUrl}/_/api/auth-check`);
      assertEquals(check.status, 401);
      const login = await fetch(`${restarted.baseUrl}/_/api/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "secret" }),
      });
      assertEquals(login.status, 200);
    } finally {
      await restarted.close();
    }
    await Deno.remove(server.vault, { recursive: true });
  });
});

Deno.test("auth: password flow requires credentials", async () => {
  const server = await bootServer({});
  try {
    const res = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "password", username: "", password: "" }),
    });
    assertEquals(res.status, 400);
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("auth: env credentials win over stored config", async () => {
  const vault = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "none" }),
    );
    const server = await bootServer({
      GLOBNOTES_PATH: vault,
      GLOBNOTES_AUTH_TYPE: "password",
      GLOBNOTES_USERNAME: "bob",
      GLOBNOTES_PASSWORD: "hunter2",
      GLOBNOTES_SECRET_KEY: "testsecret",
    });
    try {
      const setup = await fetch(`${server.baseUrl}/_/api/setup`);
      assertEquals((await setup.json()).setupRequired, false);
      const check = await fetch(`${server.baseUrl}/_/api/auth-check`);
      assertEquals(check.status, 401);
      const login = await fetch(`${server.baseUrl}/_/api/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bob", password: "hunter2" }),
      });
      assertEquals(login.status, 200);
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
