// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Integration tests for the branding endpoints: POST /_/api/brand
 * round-trip (config.json merge + brand file writes), /_/brand file
 * serving with the generated-manifest fallback, and the read-only
 * 403. Boots real server subprocesses against temp vaults.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { bootServer } from "./helpers/boot.ts";

const LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`;
const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>`;

function formData(
  fields: Record<string, string | File>,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

async function postBrand(
  baseUrl: string,
  fields: Record<string, string | File>,
): Promise<Response> {
  return await fetch(`${baseUrl}/_/api/brand`, {
    method: "POST",
    body: formData(fields),
  });
}

/** Every boot runs rewriteIndexHtml on <cwd>/client/dist/index.html — a
 * boot carrying brand or path-prefix env would stamp the real build.
 * Tests with such env boot from a scratch app dir instead. */
async function scratchAppDir(): Promise<
  { appDir: string; cleanup: () => Promise<void> }
> {
  const appDir = await Deno.makeTempDir({ prefix: "globnotes-brand-app-" });
  await Deno.mkdir(path.join(appDir, "client", "dist"), { recursive: true });
  await Deno.writeTextFile(
    path.join(appDir, "client", "dist", "index.html"),
    `<html><head></head><body>INDEX</body></html>`,
  );
  return {
    appDir,
    cleanup: () => Deno.remove(appDir, { recursive: true }),
  };
}

Deno.test("brand: POST round-trip", async (t) => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await t.step("sets name and accent, persists to config.json", async () => {
      const res = await postBrand(server.baseUrl, {
        name: "Acme Notes",
        accent: "#ff6600",
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        name: "Acme Notes",
        accent: "#ff6600",
        files: [],
      });
      const stored = JSON.parse(
        await Deno.readTextFile(
          path.join(server.vault, ".globnotes", "config.json"),
        ),
      );
      assertEquals(stored.brand_name, "Acme Notes");
      assertEquals(stored.brand_accent, "#ff6600");
    });

    await t.step("config endpoint reports the brand block", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/config`);
      assertEquals((await res.json()).brand, {
        name: "Acme Notes",
        accent: "#ff6600",
        files: [],
      });
    });

    await t.step("uploads logo.svg and icon.svg", async () => {
      const res = await postBrand(server.baseUrl, {
        logo: new File([LOGO_SVG], "anything.svg", { type: "image/svg+xml" }),
        icon: new File([ICON_SVG], "icon.svg", { type: "image/svg+xml" }),
      });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).files, ["icon.svg", "logo.svg"]);
      assertEquals(
        await Deno.readTextFile(
          path.join(server.vault, ".globnotes", "brand", "logo.svg"),
        ),
        LOGO_SVG,
      );
      assertEquals(
        await Deno.readTextFile(
          path.join(server.vault, ".globnotes", "brand", "icon.svg"),
        ),
        ICON_SVG,
      );
    });

    await t.step("serves the files with mimetype", async () => {
      for (
        const [name, body] of [["logo.svg", LOGO_SVG], ["icon.svg", ICON_SVG]]
      ) {
        const res = await fetch(`${server.baseUrl}/_/brand/${name}`);
        assertEquals(res.status, 200);
        assertEquals(res.headers.get("content-type"), "image/svg+xml");
        assertEquals(await res.text(), body);
      }
    });

    await t.step("png upload accepted, svg→png replaces", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const res = await postBrand(server.baseUrl, {
        logo: new File([png], "logo.png", { type: "image/png" }),
      });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).files, ["icon.svg", "logo.png"]);
      // The prior logo.svg is gone — a slot keeps only its newest upload.
      const res2 = await fetch(`${server.baseUrl}/_/brand/logo.svg`);
      assertEquals(res2.status, 404);
      const res3 = await fetch(`${server.baseUrl}/_/brand/logo.png`);
      assertEquals(res3.status, 200);
      assertEquals(res3.headers.get("content-type"), "image/png");
    });

    await t.step("non-image upload is rejected", async () => {
      const res = await postBrand(server.baseUrl, {
        logo: new File(["plain text"], "logo.txt", { type: "text/plain" }),
      });
      assertEquals(res.status, 400);
    });

    await t.step("invalid accent is rejected", async () => {
      const res = await postBrand(server.baseUrl, { accent: "ff6600" });
      assertEquals(res.status, 400);
    });

    await t.step("remove flags delete the files", async () => {
      const res = await postBrand(server.baseUrl, {
        removeLogo: "true",
        removeIcon: "1",
      });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).files, []);
      const res2 = await fetch(`${server.baseUrl}/_/brand/logo.png`);
      assertEquals(res2.status, 404);
    });

    await t.step(
      "empty strings clear name and accent in config.json",
      async () => {
        const res = await postBrand(server.baseUrl, { name: "", accent: "" });
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { name: null, accent: null, files: [] });
        const stored = JSON.parse(
          await Deno.readTextFile(
            path.join(server.vault, ".globnotes", "config.json"),
          ),
        );
        assert(!("brand_name" in stored));
        assert(!("brand_accent" in stored));
      },
    );
  } finally {
    await server.close();
  }
});

Deno.test("brand: file serving guards", async (t) => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    const brandDir = path.join(server.vault, ".globnotes", "brand");
    await Deno.mkdir(brandDir, { recursive: true });
    await Deno.writeTextFile(path.join(brandDir, "logo.svg"), LOGO_SVG);

    await t.step("unknown file 404s", async () => {
      const res = await fetch(`${server.baseUrl}/_/brand/nope.svg`);
      assertEquals(res.status, 404);
    });

    await t.step("traversal is rejected", async () => {
      const res = await fetch(
        `${server.baseUrl}/_/brand/..%2F..%2Fconfig.json`,
      );
      assertEquals(res.status, 404);
    });
  } finally {
    await server.close();
  }
});

Deno.test("brand: generated web manifest", async (t) => {
  await t.step("defaults without branding", async () => {
    const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
    try {
      const res = await fetch(`${server.baseUrl}/_/brand/site.webmanifest`);
      assertEquals(res.status, 200);
      assertEquals(
        res.headers.get("content-type"),
        "application/manifest+json",
      );
      const manifest = await res.json();
      assertEquals(manifest.name, "globnotes");
      assertEquals(manifest.short_name, "globnotes");
      assertEquals(manifest.start_url, "/_/");
      assertEquals(manifest.theme_color, "#38BDF8");
      assertEquals(manifest.icons[0].src, "/_/assets/favicon-16x16.png");
    } finally {
      await server.close();
    }
  });

  await t.step("carries brand name, accent, and custom icon", async () => {
    // Scratch cwd: boot runs rewriteIndexHtml on client/dist, and a brand
    // name would stamp itself into the real build's <title>.
    const { appDir, cleanup: cleanupApp } = await scratchAppDir();
    const server = await bootServer(
      {
        GLOBNOTES_AUTH_TYPE: "none",
        GLOBNOTES_BRAND_NAME: "Test Brand",
        GLOBNOTES_BRAND_ACCENT: "#ff6600",
      },
      { cwd: appDir },
    );
    try {
      const brandDir = path.join(server.vault, ".globnotes", "brand");
      await Deno.mkdir(brandDir, { recursive: true });
      await Deno.writeTextFile(path.join(brandDir, "icon.svg"), ICON_SVG);
      const res = await fetch(`${server.baseUrl}/_/brand/site.webmanifest`);
      const manifest = await res.json();
      assertEquals(manifest.name, "Test Brand");
      assertEquals(manifest.short_name, "Test Brand");
      assertEquals(manifest.theme_color, "#ff6600");
      assertEquals(manifest.icons, [{
        src: "/_/brand/icon.svg",
        sizes: "any",
      }]);
    } finally {
      await server.close();
      await cleanupApp();
    }
  });

  await t.step("custom manifest file is served as-is", async () => {
    const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
    try {
      const brandDir = path.join(server.vault, ".globnotes", "brand");
      await Deno.mkdir(brandDir, { recursive: true });
      await Deno.writeTextFile(
        path.join(brandDir, "site.webmanifest"),
        '{"name":"hand-dropped"}',
      );
      const res = await fetch(`${server.baseUrl}/_/brand/site.webmanifest`);
      assertEquals(await res.json(), { name: "hand-dropped" });
    } finally {
      await server.close();
    }
  });

  await t.step("start_url respects the path prefix", async () => {
    // Scratch cwd: a prefixed boot would stamp /notes into the real
    // build's asset URLs via rewriteIndexHtml.
    const { appDir, cleanup } = await scratchAppDir();
    const server = await bootServer(
      { GLOBNOTES_AUTH_TYPE: "none", GLOBNOTES_PATH_PREFIX: "/notes" },
      { cwd: appDir },
    );
    try {
      const res = await fetch(
        `${server.baseUrl}/notes/_/brand/site.webmanifest`,
      );
      assertEquals((await res.json()).start_url, "/notes");
    } finally {
      await server.close();
      await cleanup();
    }
  });
});

Deno.test("brand: read-only auth forbids mutation", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "read_only" });
  try {
    const res = await postBrand(server.baseUrl, { name: "Nope" });
    assertEquals(res.status, 403);
    // Reads stay open.
    const config = await fetch(`${server.baseUrl}/_/api/config`);
    assertEquals((await config.json()).brand.name, null);
  } finally {
    await server.close();
  }
});
