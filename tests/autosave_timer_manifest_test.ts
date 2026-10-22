// SPDX-License-Identifier: LGPL-3.0-only

import { assertEquals } from "@std/assert";
import { readManifest } from "../server/plugins/manifest.ts";
import { effectivePageValues } from "../server/plugins/settings.ts";

Deno.test("shipped autosave timer: browser-only manifest validates with opt-in settings", () => {
  const manifest = readManifest(
    new URL("../plugins/globnotes-autosave-timer", import.meta.url).pathname,
  );
  assertEquals(manifest.runtime, { client: "app.js" });
  assertEquals(manifest.entry, undefined);
  assertEquals(manifest.hasClient, false);
  assertEquals(manifest.hasEndpoints, false);
  assertEquals(manifest.hooks, []);
  assertEquals(manifest.license, "LGPL-3.0-only");
  assertEquals(manifest.settings.length, 1);
  const page = manifest.settings[0];
  assertEquals(page.id, "autosave");
  assertEquals(page.groups?.[0].tone, "warning");
  assertEquals(page.groups?.[0].fields, ["enabled"]);
  assertEquals(page.groups?.[0].description?.split("\n\n").length, 3);
  assertEquals(effectivePageValues(page), {
    enabled: false,
    mode: "pause",
    pauseSeconds: 2,
    intervalSeconds: 30,
  });
});
