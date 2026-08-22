#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Parity harness: the published Python globnotes image vs the Deno
 * rewrite, side-by-side on identical fixture vaults, diffing every
 * endpoint's response.
 *
 * Normalized (legitimately divergent by design):
 *   - lastModified timestamps
 *   - bm25 score VALUES (Whoosh vs FTS5 ranking) — presence compared
 *   - highlight TAG NAMES (Whoosh <strong class="match"> vs FTS5 <mark>)
 *   - index.html / built asset bytes (different viewer builds)
 *   - additive fields (Deno config exposes autoEnablePlugins)
 *
 * Usage: node scripts/parity-check.mjs
 * Requires: docker, deno in PATH.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The Python server runs from the main worktree's source (read-only
 * symlink) with a venv + a temp app dir holding a copy of client/dist. */
const PY_APP_DIR = "/tmp/parity-py-app";
const PY_VENV = "/tmp/parity-venv";
const PY_PORT = 8101;
const DENO_PORT = 8102;

// ---------------------------------------------------------------- fixture

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const FILES = {
  "readme.md": "# Welcome\n\nsee [[note-a|Note A]] and #taggy\n",
  "note-a.md": "# A\n\nbody with needle and an em-dash\n",
  "tags.md": "#docs #project-a\n\ntagged note\n",
  "folder/note-b.md": "## B\n\n> [!note] careful\n\n==marked==\n",
  "folder/inner/note-c.md": "```js\nlet x = 1;\n```\n",
  "plain.txt": "plain text",
  "script.html": "<script>alert(1)</script>",
  "draw.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
  "folder/img.png": PNG,
};

function makeFixtureVault() {
  const dir = mkdtempSync(join(tmpdir(), "globnotes-parity-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

// ---------------------------------------------------------------- servers

const procs = [];
function killAll() {
  for (const p of procs) {
    try { p.kill("SIGKILL"); } catch {}
  }
}
process.on("SIGINT", () => { killAll(); process.exit(130); });

async function waitHealth(url, name, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/_/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not become healthy in ${timeoutMs}ms`);
}

async function waitIndexReady(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/_/api/index-status`);
    if (r.ok) {
      const s = await r.json();
      if (!s.syncing && !s.initial) return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`index sync did not complete on ${base}`);
}

// ---------------------------------------------------------------- diffing

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    failures.push({ label, detail });
    console.log(`FAIL ${label} ${detail}`);
  }
}

function normalize(obj, { stripExtra = false, allowExtra = [] } = {}) {
  if (Array.isArray(obj)) return obj.map((x) => normalize(x));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (allowExtra.includes(k)) continue;
      if (k === "lastModified") out[k] = 0;
      else if (k === "score") out[k] = v === null ? null : 1;
      else if (k === "titleHighlights" || k === "contentHighlights") {
        // Whoosh: <strong class="match term0">x</strong>; FTS5: <mark>x</mark>.
        // Parity = same field populated (or not).
        out[k] = v === null || v === undefined ? null : Boolean(v);
      } else out[k] = normalize(v);
    }
    return out;
  }
  return obj;
}

async function jsonOf(res) {
  return normalize(await res.json());
}

async function compareJson(label, path, init) {
  const [py, deno] = await Promise.all([
    fetch(`http://localhost:${PY_PORT}${path}`, init),
    fetch(`http://localhost:${DENO_PORT}${path}`, init),
  ]);
  check(`${label} (status)`, py.status === deno.status,
    `py=${py.status} deno=${deno.status}`);
  const [pyBody, denoBody] = [await jsonOf(py), await jsonOf(deno)];
  check(
    `${label} (body)`,
    JSON.stringify(pyBody) === JSON.stringify(denoBody),
    `\n  py:   ${JSON.stringify(pyBody)}\n  deno: ${JSON.stringify(denoBody)}`,
  );
}

async function compareFile(label, path, { headers = [] } = {}) {
  const [py, deno] = await Promise.all([
    fetch(`http://localhost:${PY_PORT}${path}`),
    fetch(`http://localhost:${DENO_PORT}${path}`),
  ]);
  check(`${label} (status)`, py.status === deno.status,
    `py=${py.status} deno=${deno.status}`);
  for (const h of headers) {
    check(
      `${label} (${h})`,
      py.headers.get(h) === deno.headers.get(h),
      `py=${py.headers.get(h)} deno=${deno.headers.get(h)}`,
    );
  }
  const [pyBody, denoBody] = await Promise.all([
    py.arrayBuffer(),
    deno.arrayBuffer(),
  ]);
  check(
    `${label} (body)`,
    Buffer.compare(Buffer.from(pyBody), Buffer.from(denoBody)) === 0,
    `py=${pyBody.byteLength}B deno=${denoBody.byteLength}B`,
  );
}

async function compareStatusType(label, path) {
  const [py, deno] = await Promise.all([
    fetch(`http://localhost:${PY_PORT}${path}`),
    fetch(`http://localhost:${DENO_PORT}${path}`),
  ]);
  check(`${label} (status)`, py.status === deno.status,
    `py=${py.status} deno=${deno.status}`);
  check(
    `${label} (content-type)`,
    py.headers.get("content-type") === deno.headers.get("content-type"),
    `py=${py.headers.get("content-type")} deno=${deno.headers.get("content-type")}`,
  );
  await py.body?.cancel();
  await deno.body?.cancel();
}

// ---------------------------------------------------------------- main

const vaultPy = makeFixtureVault();
const vaultDeno = mkdtempSync(join(tmpdir(), "globnotes-parity-"));
cpSync(vaultPy, vaultDeno, { recursive: true });

try {
  // Python server (main worktree source, venv, temp app dir).
  const py = spawn(
    `${PY_VENV}/bin/python`,
    [
      "-m", "uvicorn", "main:app",
      "--app-dir", "server",
      "--host", "127.0.0.1",
      "--port", String(PY_PORT),
    ],
    {
      cwd: PY_APP_DIR,
      env: {
        ...process.env,
        GLOBNOTES_AUTH_TYPE: "none",
        GLOBNOTES_PATH: vaultPy,
        PYTHONDONTWRITEBYTECODE: "1",
        NO_COLOR: "1",
      },
      stdio: "ignore",
    },
  );
  procs.push(py);

  // Deno server from the worktree
  const deno = spawn(
    "deno",
    [
      "run", "--unstable-worker-options",
      "--allow-net", "--allow-read", "--allow-write", "--allow-env",
      "server/main.ts",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GLOBNOTES_AUTH_TYPE: "none",
        GLOBNOTES_PATH: vaultDeno,
        GLOBNOTES_PORT: String(DENO_PORT),
        GLOBNOTES_HOST: "127.0.0.1",
        NO_COLOR: "1",
      },
      stdio: "ignore",
    },
  );
  procs.push(deno);

  await waitHealth(`http://localhost:${PY_PORT}`, "python");
  await waitHealth(`http://localhost:${DENO_PORT}`, "deno");
  await waitIndexReady(`http://localhost:${PY_PORT}`);
  await waitIndexReady(`http://localhost:${DENO_PORT}`);

  // -- infrastructure --------------------------------------------------
  await compareJson("health", "/_/api/health");
  await compareJson("setup", "/_/api/setup");

  // Config: Deno exposes the additive autoEnablePlugins field — strip it.
  {
    const [py, deno] = await Promise.all([
      fetch(`http://localhost:${PY_PORT}/_/api/config`).then((r) => r.json()),
      fetch(`http://localhost:${DENO_PORT}/_/api/config`).then((r) => r.json()),
    ]);
    delete deno.autoEnablePlugins;
    check(
      "config (common fields)",
      JSON.stringify(normalize(py)) === JSON.stringify(normalize(deno)),
      `\n  py:   ${JSON.stringify(py)}\n  deno: ${JSON.stringify(deno)}`,
    );
  }

  await compareJson("index-status shape", "/_/api/index-status");

  // -- notes CRUD ------------------------------------------------------
  await compareJson("notes create", "/_/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "created/note", content: "new body" }),
  });
  await compareJson("notes create duplicate", "/_/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "created/note", content: "again" }),
  });
  await compareJson("notes create invalid", "/_/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "", content: "" }),
  });
  await compareJson("notes get", "/_/api/notes/note-a");
  await compareJson("notes get nested", "/_/api/notes/folder%2Fnote-b");
  await compareJson("notes get missing", "/_/api/notes/nope");
  await compareJson("notes get traversal", "/_/api/notes/..%2F..%2Fetc");
  await compareJson("notes patch content", "/_/api/notes/note-a", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newContent: "replaced body" }),
  });
  await compareJson("notes rename", "/_/api/notes/folder%2Fnote-b", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newTitle: "folder/note-b-renamed" }),
  });
  await compareJson("rename-preview", "/_/api/rename-preview?title=created%2Fnote&new_title=moved%2Fnote");

  // -- search ------------------------------------------------------------
  for (const term of ["*", "needle", "folder", "careful"]) {
    await compareJson(
      `search '${term}'`,
      `/_/api/search?term=${encodeURIComponent(term)}`,
    );
  }
  await compareJson("search #taggy", "/_/api/search?term=%23taggy");
  await compareJson(
    "search sort title asc",
    "/_/api/search?term=*&sort=title&order=asc",
  );
  await compareJson(
    "search nested=false",
    "/_/api/search?term=*&nested=false",
  );
  await compareJson(
    "search folder filter",
    `/_/api/search?term=*&folder=${encodeURIComponent("folder")}`,
  );
  await compareJson("tags", "/_/api/tags");
  await compareJson("note-index", "/_/api/note-index");
  await compareJson("tree root", "/_/api/tree?path=");
  await compareJson("tree subfolder", "/_/api/tree?path=folder");
  await compareJson("tree missing", "/_/api/tree?path=nope%2Fnada");
  await compareJson("tree traversal", "/_/api/tree?path=..%2F..");

  // -- files ---------------------------------------------------------------
  await compareFile("api file png", "/_/api/files/folder%2Fimg.png", {
    headers: ["content-type", "content-disposition"],
  });
  await compareFile("api file plain text", "/_/api/files/plain.txt", {
    headers: ["content-type"],
  });
  await compareFile("api file markdown", "/_/api/files/note-a.md", {
    headers: ["content-type"],
  });
  await compareFile("api file html download", "/_/api/files/script.html", {
    headers: ["content-type", "content-disposition"],
  });
  await compareFile("api file svg csp", "/_/api/files/draw.svg", {
    headers: ["content-type", "content-security-policy"],
  });
  await compareJson("api file missing", "/_/api/files/nope.png");
  await compareJson("api file hidden", "/_/api/files/.globnotes%2Fconfig.json");

  // upload (both get the same multipart payload)
  for (const port of [PY_PORT, DENO_PORT]) {
    const form = new FormData();
    form.set("file", new File([PNG], "upload.png"), "upload.png");
    form.set("directory", "folder");
    const r = await fetch(`http://localhost:${port}/_/api/files`, {
      method: "POST",
      body: form,
    });
    globalThis[`_upload_${port}`] = { status: r.status, body: await r.json() };
  }
  check(
    "upload (status)",
    globalThis[`_upload_${PY_PORT}`].status ===
      globalThis[`_upload_${DENO_PORT}`].status,
  );
  check(
    "upload (body)",
    JSON.stringify(globalThis[`_upload_${PY_PORT}`].body) ===
      JSON.stringify(globalThis[`_upload_${DENO_PORT}`].body),
    `\n  py:   ${JSON.stringify(globalThis[`_upload_${PY_PORT}`].body)}\n  deno: ${JSON.stringify(globalThis[`_upload_${DENO_PORT}`].body)}`,
  );
  await compareFile("uploaded file readable", "/_/api/files/folder%2Fupload.png", {
    headers: ["content-type"],
  });

  // -- catch-all --------------------------------------------------------
  await compareFile("catch-all vault file", "/folder/img.png", {
    headers: ["content-type", "content-disposition"],
  });
  await compareFile("catch-all svg", "/draw.svg", {
    headers: ["content-type", "content-security-policy"],
  });
  await compareFile("catch-all html download", "/script.html", {
    headers: ["content-disposition"],
  });
  await compareStatusType("catch-all note page", "/note-a");
  await compareStatusType("catch-all missing note page", "/no/such/note");
  await compareJson("catch-all hidden", "/.globnotes/config.json");

  // DELETE last (mutates both vaults).
  await compareJson("notes delete", "/_/api/notes/created%2Fnote", {
    method: "DELETE",
  });

  console.log(`\n== parity: ${pass} passed, ${fail} failed ==`);
  killAll();
  rmSync(vaultPy, { recursive: true, force: true });
  rmSync(vaultDeno, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  console.error("harness error:", e);
  killAll();
  rmSync(vaultPy, { recursive: true, force: true });
  rmSync(vaultDeno, { recursive: true, force: true });
  process.exit(2);
}
