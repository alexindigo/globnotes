// SPDX-License-Identifier: LGPL-3.0-only

import { assertEquals, assertStringIncludes } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

Deno.test("multi-vault: isolation, picker, unknown slug", async () => {
  const dad = await Deno.makeTempDir();
  const mom = await Deno.makeTempDir();
  await Deno.mkdir(`${dad}/recipes`, { recursive: true });
  await Deno.mkdir(`${mom}/recipes`, { recursive: true });
  await Deno.writeTextFile(`${dad}/recipes/soup.md`, "see [[ideas]]");
  await Deno.writeTextFile(`${dad}/ideas.md`, "dad ideas");
  await Deno.writeTextFile(`${mom}/recipes/soup.md`, "mom soup");
  const server = await bootServer({
    GLOBNOTES_VAULTS: `dad:${dad},mom:${mom}`,
    GLOBNOTES_AUTH_TYPE_dad: "none",
    GLOBNOTES_AUTH_TYPE_mom: "none",
  });
  try {
    const dadSoup = await fetch(
      `${server.baseUrl}/dad/_/api/notes/recipes/soup`,
    );
    assertEquals(dadSoup.status, 200);
    assertEquals((await dadSoup.json()).content, "see [[ideas]]");

    const momSoup = await fetch(
      `${server.baseUrl}/mom/_/api/notes/recipes/soup`,
    );
    assertEquals(momSoup.status, 200);
    assertEquals((await momSoup.json()).content, "mom soup");

    const dadAsMom = await fetch(`${server.baseUrl}/mom/_/api/notes/ideas`);
    assertEquals(dadAsMom.status, 404);

    const nope = await fetch(`${server.baseUrl}/nope/`);
    assertEquals(nope.status, 404);

    const health = await fetch(`${server.baseUrl}/_/api/health`);
    assertEquals(health.status, 200);

    const vaults = await fetch(`${server.baseUrl}/_/api/vaults`);
    assertEquals(vaults.status, 200);
    const list = await vaults.json() as { slug: string }[];
    assertEquals(list.map((v) => v.slug).sort(), ["dad", "mom"]);

    const rendered = await fetch(
      `${server.baseUrl}/dad/_/api/render/recipes/soup`,
    );
    assertEquals(rendered.status, 200);
    const html = await rendered.text();
    assertStringIncludes(html, 'href="/dad/ideas"');
    assertEquals(
      await Deno.readTextFile(`${dad}/recipes/soup.md`),
      "see [[ideas]]",
    );
  } finally {
    await server.close();
    await Deno.remove(dad, { recursive: true });
    await Deno.remove(mom, { recursive: true });
  }
});

Deno.test("multi-vault: PATH-only URLs unchanged", async () => {
  const vault = await Deno.makeTempDir();
  await Deno.writeTextFile(`${vault}/recipes.md`, "one");
  const server = await bootServer({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "none",
  });
  try {
    const health = await fetch(`${server.baseUrl}/_/api/health`);
    assertEquals(health.status, 200);
    const note = await fetch(`${server.baseUrl}/_/api/notes/recipes`);
    assertEquals(note.status, 200);
    assertEquals((await note.json()).content, "one");
  } finally {
    await server.close();
    await Deno.remove(vault, { recursive: true });
  }
});
