// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

for (const mode of ["none", "setup", "read_only"]) {
  Deno.test(`session startup: invalid unused legacy expiry does not stop ${mode}`, async () => {
    const server = await bootServer({
      GLOBNOTES_AUTH_TYPE: mode === "setup" ? "" : mode,
      GLOBNOTES_SESSION_EXPIRY_DAYS: "not-an-integer",
    });
    try {
      const response = await fetch(`${server.baseUrl}/_/api/config`);
      assertEquals(response.status, 200);
      const config = await response.json();
      assertEquals(config.setupRequired, mode === "setup");
      assertEquals(config.authType, mode === "setup" ? null : mode);
    } finally {
      await server.close();
    }
  });
}

Deno.test("session startup: local authentication still rejects invalid used legacy expiry", async () => {
  await assertRejects(
    () =>
      bootServer({
        GLOBNOTES_AUTH_TYPE: "password",
        GLOBNOTES_USERNAME: "owner",
        GLOBNOTES_PASSWORD: "fixture password",
        GLOBNOTES_SECRET_KEY: "fixture signing material",
        GLOBNOTES_SESSION_EXPIRY_DAYS: "not-an-integer",
      }),
    Error,
    "GLOBNOTES_SESSION_EXPIRY_DAYS",
  );
});
