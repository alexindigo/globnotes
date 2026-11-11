// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

/** Fresh metadata preparation must not look like out-of-band configuration edits. */
Deno.test("config bootstrap: first branding save after fresh setup retains valid parent binding", async () => {
  const root = await Deno.makeTempDir({ prefix: "config-bootstrap-binding-" });
  const vault = `${root}/globnotes`;
  await Deno.mkdir(vault);
  const server = await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault });
  try {
    const setup = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "none", readOnlySettings: false }),
    });
    assertEquals(setup.status, 200);
    await setup.body?.cancel();
    const form = new FormData();
    form.append("name", "First saved brand");
    const response = await fetch(`${server.baseUrl}/_/api/brand`, {
      method: "POST",
      body: form,
    });
    const body = await response.json();
    const config = await fetch(`${server.baseUrl}/_/api/config`).then(
      (response) => response.json(),
    );
    console.log(JSON.stringify({
      retainedBootstrapFixture: root,
      setupStatus: setup.status,
      brandStatus: response.status,
      body,
      brandConsumer: config.brand,
      metadataEntries: [...Deno.readDirSync(`${vault}/.globnotes`)].map(
        (entry) => entry.name,
      ).sort(),
    }));
    assertEquals(response.status, 200);
    assertEquals(config.brand.name, "First saved brand");
  } finally {
    await server.close();
  }
});
