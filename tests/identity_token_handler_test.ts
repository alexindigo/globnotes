// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { identityTokenHandler } from "../server/auth/token_handler.ts";
import { AuthenticationError } from "../server/auth/sessions.ts";
import { credentialCommandFixture } from "./helpers/credential_commands.ts";
import { ACCOUNT_A } from "./helpers/identity.ts";

const request = (password = "password", totp?: string) =>
  new Request("http://fixture/_/api/token", {
    method: "POST",
    body: JSON.stringify({
      username: "alice",
      password,
      ...(totp === undefined ? {} : { totp }),
    }),
  });

Deno.test("token adapter: malformed JSON is a request parse error", () =>
  credentialCommandFixture(async (f) => {
    const error = await assertRejects(
      () =>
        identityTokenHandler(f.sessions)(
          new Request("http://fixture/_/api/token", {
            method: "POST",
            body: "{",
          }),
        ),
      HttpError,
      "HTTP 400",
    );
    assertEquals([error.status, error.detail], [
      400,
      "Invalid JSON request body.",
    ]);
  }));

Deno.test("token adapter: password-only token is delivered through the issued body", () =>
  credentialCommandFixture(async (f) => {
    const response = await identityTokenHandler(f.sessions)(request());
    const body = await response.json();
    assertEquals([
      response.status,
      response.headers.get("content-type"),
      Object.keys(body).sort(),
      body.principal.accountId,
      body.token_type,
    ], [
      200,
      "application/json",
      ["access_token", "principal", "token_type"],
      ACCOUNT_A,
      "bearer",
    ]);
    assertEquals(
      await f.sessions.validateToken(body.access_token),
      body.principal,
    );
  }));

Deno.test("token adapter: only proven password discloses the safe code step and spends no code", () =>
  credentialCommandFixture(
    async (f) => {
      const handler = identityTokenHandler(f.sessions);
      const before = Deno.readTextFileSync(`${f.root}/accounts.json`);
      const bad = await handler(request("wrong"));
      const next = await handler(request());
      assertEquals([
        bad.status,
        await bad.json(),
        next.status,
        await next.json(),
      ], [
        401,
        {
          detail: "Invalid authentication credentials.",
          code: "credentials_refused",
        },
        401,
        { message: "Invalid credentials.", code: "authenticator_required" },
      ]);
      assertEquals(Deno.readTextFileSync(`${f.root}/accounts.json`), before);
      const code = await f.code();
      const response = await handler(request("password", code));
      const body = await response.json();
      assertEquals(
        (await f.sessions.validateToken(body.access_token)).accountId,
        ACCOUNT_A,
      );
      const reused = await handler(request("password", code));
      assertEquals([reused.status, await reused.json()], [
        401,
        {
          detail: "Invalid authentication credentials.",
          code: "credentials_refused",
        },
      ]);
    },
    {},
    { key: "key", floor: 1 },
  ));

Deno.test("token adapter: a prepared response cannot deliver a subsequently retired credential", () =>
  credentialCommandFixture(async (f) => {
    const response = await identityTokenHandler(f.sessions)(request());
    // Retiring the aggregate ends this issued response, not a second token DTO.
    f.accounts.retireCredentials();
    await assertRejects(
      () => response.json(),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
  }));
