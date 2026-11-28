// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertMatch } from "@std/assert";
import { createUuid } from "../shared/uuid.ts";
import { bootServer } from "./helpers/boot.ts";
import { publicScenario } from "./helpers/fixture_scenarios.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";

Deno.test("enabled Autosave settings disclose values to Edit/View and the page only to Admin", () =>
  fixtureScope(async (scope) => {
    const server = (await scope.acquire(() =>
      bootServer({ fixtureScenario: publicScenario() }), (server) =>
      server.close())).value;
    const settings = "plugin-host/globnotes-autosave-timer/settings/autosave";
    async function call(
      path: string,
      method = "GET",
      body?: unknown,
      token?: string,
    ) {
      const response = await fetch(`${server.baseUrl}/_/api/${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    }
    const login = await call("token", "POST", {
      username: "alice",
      password: "password",
    });
    assertEquals(login.status, 200);
    const token = login.body.access_token;
    const admin = await call(settings, "GET", undefined, token);
    assertEquals(admin.status, 200);
    assertEquals(Object.keys(admin.body).sort(), [
      "fields",
      "revision",
      "sourceKey",
      "values",
    ]);
    assertEquals(admin.body.revision, 0);
    assertMatch(admin.body.sourceKey, /^[a-f0-9]{64}$/);
    assertEquals(Object.keys(admin.body.fields).sort(), [
      "enabled",
      "intervalSeconds",
      "mode",
      "pauseSeconds",
    ]);
    const serverOnly = "plugin-host/globnotes-backup/settings/backup";
    const missingPage = "plugin-host/globnotes-autosave-timer/settings/absent";
    const missingPlugin = "plugin-host/absent/settings/backup";
    assertEquals((await call(serverOnly, "GET", undefined, token)).status, 200);
    for (const path of [missingPage, missingPlugin]) {
      assertEquals(await call(path, "GET", undefined, token), {
        status: 404,
        body: { detail: "Not Found" },
      });
    }
    const values = {
      enabled: true,
      intervalSeconds: 30,
      mode: "pause",
      pauseSeconds: 5,
    };
    const save = await call(settings, "PUT", {
      values,
      revision: admin.body.revision,
      sourceKey: admin.body.sourceKey,
    }, token);
    assertEquals([save.status, save.body.values, save.body.revision], [
      200,
      values,
      1,
    ]);
    for (const everybody of ["edit", "view", "none"] as const) {
      const { body: { revision, signature, grants } } = await call(
        "access",
        "GET",
        undefined,
        token,
      );
      const update = await call("access", "PUT", {
        revision,
        signature,
        grants,
        everybody,
        updateId: createUuid(),
      }, token);
      assertEquals(update.status, 200);
      const guest = await call(settings);
      if (everybody === "none") {
        assertEquals(guest.status, 403);
      } else assertEquals(guest, { status: 200, body: { values } });
      const denied = {
        status: 403,
        body: {
          detail: "This account cannot perform that operation.",
          code: "operation_not_permitted",
        },
      };
      for (const path of [serverOnly, missingPage, missingPlugin]) {
        assertEquals(await call(path), denied);
      }
      assertEquals(
        (await call(settings, "PUT", {
          values: { ...values, enabled: false },
          revision: 1,
          sourceKey: save.body.sourceKey,
        })).status,
        403,
      );
    }
    const check = await call(settings, "GET", undefined, token);
    assertEquals([check.status, check.body.values, check.body.revision], [
      200,
      values,
      1,
    ]);
  }));
