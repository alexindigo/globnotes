// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Integration tests for file serving, upload, and the root catch-all —
 * the Deno port of tests/test_file_serving.py + the catch-all behaviour
 * of the Python server. Boots real server subprocesses.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { rewriteIndexHtml } from "../server/helpers.ts";
import { bootServer, type TestServer } from "./helpers/boot.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function makeApp(): Promise<{ appDir: string; vault: string }> {
  const appDir = await Deno.makeTempDir({ prefix: "globnotes-app-" });
  const vault = await Deno.makeTempDir({ prefix: "globnotes-vault-" });
  const dist = path.join(appDir, "client", "dist");
  await Deno.mkdir(path.join(dist, "assets"), { recursive: true });
  await Deno.writeTextFile(
    path.join(dist, "index.html"),
    `<html><head></head><body>INDEX</body></html>`,
  );
  await Deno.writeTextFile(path.join(dist, "assets", "app.css"), "body{}");
  return { appDir, vault };
}

async function bootWithApp(
  env: Record<string, string> = {},
): Promise<TestServer & { appDir: string }> {
  const { appDir, vault } = await makeApp();
  const server = await bootServer(
    { GLOBNOTES_AUTH_TYPE: "none", ...env, GLOBNOTES_PATH: vault },
    { cwd: appDir },
  );
  return { ...server, appDir };
}

async function cleanup(
  server: TestServer & { appDir?: string },
): Promise<void> {
  await server.close();
  await Deno.remove(server.vault, { recursive: true });
  if (server.appDir) await Deno.remove(server.appDir, { recursive: true });
}

Deno.test("files: API get", async (t) => {
  const server = await bootWithApp();
  const api = (p: string) => fetch(`${server.baseUrl}/_/api/files/${p}`);
  try {
    await Deno.writeFile(path.join(server.vault, "img.png"), PNG);
    await Deno.writeTextFile(
      path.join(server.vault, "plain.txt"),
      "hello",
    );
    await Deno.writeTextFile(
      path.join(server.vault, "draw.svg"),
      "<svg></svg>",
    );
    await Deno.writeTextFile(
      path.join(server.vault, "script.html"),
      "<script>alert(1)</script>",
    );
    await Deno.mkdir(path.join(server.vault, "assets"), { recursive: true });
    await Deno.writeTextFile(
      path.join(server.vault, "assets", "inner.txt"),
      "nested",
    );

    await t.step("inline image", async () => {
      const res = await api("img.png");
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "image/png");
      assertEquals(res.headers.get("content-disposition"), null);
      assertEquals(new Uint8Array(await res.arrayBuffer()), PNG);
    });

    await t.step("plain text", async () => {
      const res = await api("plain.txt");
      assertEquals(res.status, 200);
      assertEquals(
        res.headers.get("content-type"),
        "text/plain; charset=utf-8",
      );
      assertEquals(await res.text(), "hello");
    });

    await t.step("markdown fetched raw (agents)", async () => {
      await Deno.writeTextFile(path.join(server.vault, "note.md"), "# t");
      const res = await api("note.md");
      assertEquals(res.status, 200);
      assertEquals(
        res.headers.get("content-type"),
        "text/plain; charset=utf-8",
      );
      assertEquals(await res.text(), "# t");
    });

    await t.step("svg carries CSP", async () => {
      const res = await api("draw.svg");
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "image/svg+xml");
      assertEquals(
        res.headers.get("content-security-policy"),
        "script-src 'none'",
      );
    });

    await t.step("script-capable extension → forced download", async () => {
      const res = await api("script.html");
      assertEquals(res.status, 200);
      assertEquals(
        res.headers.get("content-disposition"),
        'attachment; filename="script.html"',
      );
    });

    await t.step("unknown extension → octet-stream download", async () => {
      await Deno.writeTextFile(path.join(server.vault, "blob.xyz"), "x");
      const res = await api("blob.xyz");
      assertEquals(res.status, 200);
      assertEquals(
        res.headers.get("content-type"),
        "application/octet-stream",
      );
      assertEquals(
        res.headers.get("content-disposition"),
        'attachment; filename="blob.xyz"',
      );
    });

    await t.step("nested paths", async () => {
      const res = await api("assets/inner.txt");
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "nested");
    });

    await t.step("hidden paths and missing files → 404", async () => {
      const hidden = await api(".hidden.txt");
      assertEquals(hidden.status, 404);
      await hidden.body?.cancel();
      const missing = await api("nope.png");
      assertEquals(missing.status, 404);
      assertEquals(
        (await missing.json()).detail,
        "The specified file cannot be found.",
      );
    });

    await t.step(
      "traversal attempt → 404 (hidden dot-segment check)",
      async () => {
        const res = await api("..%2Fetc%2Fpasswd");
        assertEquals(res.status, 404);
        await res.body?.cancel();
      },
    );

    await t.step("invalid path chars → 400", async () => {
      const res = await api("bad%7Cname.png");
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });
  } finally {
    await cleanup(server);
  }
});

Deno.test("files: upload", async (t) => {
  const server = await bootWithApp();
  try {
    const upload = (
      name: string,
      body: string,
      directory = "",
    ): Promise<Response> => {
      const form = new FormData();
      form.set("file", new File([body], name));
      if (directory) form.set("directory", directory);
      return fetch(`${server.baseUrl}/_/api/files`, {
        method: "POST",
        body: form,
      });
    };

    await t.step("basic upload", async () => {
      const res = await upload("pic.png", "x");
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { filename: "pic.png", url: "pic.png" });
      assertEquals(
        await Deno.readTextFile(path.join(server.vault, "pic.png")),
        "x",
      );
    });

    await t.step("duplicate gets datetime suffix", async () => {
      const res = await upload("pic.png", "y");
      assertEquals(res.status, 200);
      const body = await res.json();
      assert(
        /^pic_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.png$/.test(body.filename),
        `unexpected deduped name: ${body.filename}`,
      );
      assertEquals(body.url, encodeURIComponent(body.filename));
    });

    await t.step("upload into subdirectory", async () => {
      const res = await upload("deep.txt", "z", "sub/dir");
      assertEquals(res.status, 200);
      assertEquals(
        await Deno.readTextFile(
          path.join(server.vault, "sub", "dir", "deep.txt"),
        ),
        "z",
      );
    });

    await t.step("markdown with invalid title → 400", async () => {
      const res = await upload("bad?name.md", "x");
      assertEquals(res.status, 400);
      assertEquals(
        (await res.json()).detail,
        "The specified filename is invalid.",
      );
    });

    await t.step("hidden filename → 400", async () => {
      const res = await upload(".hidden", "x");
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });

    await t.step("directory escaping root → 400", async () => {
      const res = await upload("x.txt", "x", "..");
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });

    await t.step("valid markdown uploads fine", async () => {
      const res = await upload("ok note.md", "content");
      assertEquals(res.status, 200);
      assertEquals((await res.json()).filename, "ok note.md");
    });
  } finally {
    await cleanup(server);
  }
});

Deno.test("files: catch-all routing", async (t) => {
  const server = await bootWithApp();
  try {
    await Deno.writeFile(path.join(server.vault, "img.png"), PNG);

    await t.step("UI pages serve index.html", async () => {
      for (const page of ["/", "/_/login", "/_/search", "/_/new"]) {
        const res = await fetch(`${server.baseUrl}${page}`);
        assertEquals(res.status, 200, `page ${page}`);
        assertStringIncludes(await res.text(), "INDEX");
      }
    });

    await t.step("built assets serve from client/dist", async () => {
      const res = await fetch(`${server.baseUrl}/_/assets/app.css`);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/css");
      assertEquals(await res.text(), "body{}");
      const missing = await fetch(`${server.baseUrl}/_/assets/nope.css`);
      assertEquals(missing.status, 404);
      await missing.body?.cancel();
    });

    await t.step("vault files in root URL space", async () => {
      const res = await fetch(`${server.baseUrl}/img.png`);
      assertEquals(res.status, 200);
      assertEquals(new Uint8Array(await res.arrayBuffer()), PNG);
    });

    await t.step("note page wins for dotted titles", async () => {
      await Deno.writeTextFile(path.join(server.vault, "v2.1.md"), "body");
      const res = await fetch(`${server.baseUrl}/v2.1`);
      assertEquals(res.status, 200);
      assertStringIncludes(await res.text(), "INDEX");
    });

    await t.step("missing file with no matching note → 404", async () => {
      const res = await fetch(`${server.baseUrl}/nope.bin`);
      assertEquals(res.status, 404);
      assertEquals(
        (await res.json()).detail,
        "The specified file cannot be found.",
      );
    });

    await t.step("hidden and machinery paths → 404", async () => {
      for (const p of ["/.obsidian/x", "/_/nonexistent.css"]) {
        const res = await fetch(`${server.baseUrl}${p}`);
        assertEquals(res.status, 404, `path ${p}`);
        await res.body?.cancel();
      }
    });

    await t.step(
      "unknown underscore root serves index (Python parity)",
      async () => {
        // Python: segments[0] != "_" → falls through to serve_index.
        const res = await fetch(`${server.baseUrl}/_unknown`);
        assertEquals(res.status, 200);
        assertStringIncludes(await res.text(), "INDEX");
      },
    );

    await t.step("non-GET on unmatched path → 405", async () => {
      const res = await fetch(`${server.baseUrl}/some/path`, {
        method: "PUT",
      });
      assertEquals(res.status, 405);
      await res.body?.cancel();
    });
  } finally {
    await cleanup(server);
  }
});

Deno.test("files: catch-all requires auth for vault files", async () => {
  const { appDir, vault } = await makeApp();
  const server = await bootServer(
    { GLOBNOTES_PATH: vault },
    { cwd: appDir },
  );
  try {
    await Deno.writeFile(path.join(vault, "img.png"), PNG);
    // Complete setup so the server gates properly.
    const setup = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "password", username: "u", password: "p" }),
    });
    await setup.body?.cancel();

    const unauthed = await fetch(`${server.baseUrl}/img.png`);
    assertEquals(unauthed.status, 401);
    await unauthed.body?.cancel();

    const login = await fetch(`${server.baseUrl}/_/api/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", password: "p" }),
    });
    const { access_token } = await login.json();

    const authed = await fetch(`${server.baseUrl}/img.png`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    assertEquals(authed.status, 200);
    assertEquals(new Uint8Array(await authed.arrayBuffer()), PNG);

    // Note pages stay public (the client handles its own auth flow).
    const page = await fetch(`${server.baseUrl}/some-note`);
    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), "INDEX");
  } finally {
    await server.close();
    await Promise.all([
      Deno.remove(vault, { recursive: true }),
      Deno.remove(appDir, { recursive: true }),
    ]);
  }
});

Deno.test("files: rewriteIndexHtml", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = path.join(dir, "index.html");

    await Deno.writeTextFile(file, "<html><head></head></html>");
    rewriteIndexHtml(file, "");
    assertStringIncludes(
      await Deno.readTextFile(file),
      '<meta name="globnotes-prefix" content="">',
    );

    await Deno.writeTextFile(
      file,
      `<html><head><meta name="globnotes-prefix" content="">\n` +
        `<script src="/_/assets/app.js"></script></head></html>`,
    );
    rewriteIndexHtml(file, "/base");
    const html = await Deno.readTextFile(file);
    assertStringIncludes(html, 'content="/base"');
    assertStringIncludes(html, 'src="/base/_/assets/app.js"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
