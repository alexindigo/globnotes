// SPDX-License-Identifier: LGPL-3.0-only

/** Prefix-wrapper correction: exact segment matching and query preservation.
 * Fail-first coverage for the v2-owned app glue — plugin APIs under a path
 * prefix require intact queries. */

import { assertEquals } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { catalogPluginReady } from "./helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

Deno.test("prefix: segment boundaries, retained queries and protected plugin routes", async () => {
  const fixture = await pluginFixture();
  try {
    await fixture.install("ep", {}, {
      "endpoints/item/#name/get.js":
        `export default (req) => ({ name: req.params.name, query: req.query });`,
    });
    const server = await bootServer({
      GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES__METADATA_PATH: fixture.metadataBase,
      fixtureAuth: { auth_type: "none" },
      GLOBNOTES__SERVER_PATHPREFIX: "/notes",
    });
    try {
      // Exact prefix: app answers; queries survive the wrapper.
      const health = await fetch(`${server.baseUrl}/notes/_/api/health`);
      assertEquals(health.status, 200);
      await health.body?.cancel();

      const searched = await fetch(
        `${server.baseUrl}/notes/_/api/search?term=hello&sortBy=path`,
      );
      assertEquals(searched.status, 200);
      await searched.body?.cancel();

      // Plugin endpoints under the prefix keep their query data.
      await catalogPluginReady(server, "ep", { prefix: "/notes" });
      const pluginRes = await waitUntil(async (signal) => {
        const res = await fetch(
          `${server.baseUrl}/notes/_/api/plugins/ep/item/a%20b?x=1`,
          { signal },
        );
        if (res.status === 200) return done(res);
        return pending({ status: res.status, body: await res.text() });
      }, {
        label: "plugin endpoint answering under prefix",
        intervalMs: 100,
        children: [server],
      });
      const body = await pluginRes.json();
      assertEquals(body.name, "a b");
      assertEquals(body.query, [["x", "1"]]);

      // Segment boundaries: /notes-other is NOT the app; bare / is 404.
      assertEquals(
        (await fetch(`${server.baseUrl}/notes-other/_/api/health`)).status,
        404,
      );
      assertEquals((await fetch(`${server.baseUrl}/notes-other`)).status, 404);
      assertEquals((await fetch(`${server.baseUrl}/_/api/health`)).status, 404);

      // Host control APIs are reachable under the prefix too.
      const catalog = await fetch(`${server.baseUrl}/notes/_/api/plugin-host`);
      assertEquals(catalog.status, 200);
      await catalog.body?.cancel();
    } finally {
      await server.close();
    }
  } finally {
    await fixture.dispose();
  }
});
