// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

for (const mode of ["none", "setup", "read_only"]) {
  Deno.test(`session startup: typed expiry supports ${mode}`, async () => {
    const server = await bootServer({
      fixtureAuth: mode === "setup" ? undefined : { auth_type: mode },
      GLOBNOTES__SESSIONS_EXPIRYDAYS: "3",
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
  Deno.test(`session startup: cutover validates typed expiry even in ${mode}`, async () => {
    await assertRejects(
      () =>
        bootServer({
          fixtureAuth: mode === "setup" ? undefined : { auth_type: mode },
          GLOBNOTES__SESSIONS_EXPIRYDAYS: "not-an-integer",
        }),
      Error,
      "GLOBNOTES__SESSIONS_EXPIRYDAYS",
    );
  });
}
