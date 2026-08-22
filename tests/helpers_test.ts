// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  camelCase,
  hashPassword,
  isValidNotePath,
  resolveInRoot,
  verifyPassword,
} from "../server/helpers.ts";

Deno.test("isValidNotePath: valid paths", () => {
  const valid = [
    "note",
    "My Note",
    "a/b",
    "a/b/c/d/e",
    "dad/recipes/soup",
    "émojis🎉/ok",
    " spaces ok /inside ",
    "_foo",
    "_notes/todo",
    "foo/_",
    "_foo/bar/baz",
    "__drafts",
  ];
  for (const title of valid) {
    assertEquals(isValidNotePath(title), title);
  }
});

Deno.test("isValidNotePath: invalid paths", () => {
  const invalid = [
    "",
    "_",
    "_/something",
    "_/a/b",
    "_/_",
    "a//b",
    "/a",
    "a/",
    "./a",
    "a/./b",
    "..",
    "../a",
    "a/../b",
    "a/b/..",
    ".hidden",
    "a/.hidden",
    "a/.hidden/b",
    "a<b",
    "a>b",
    "a:b",
    'a"b',
    "a\\b",
    "a|b",
    "a?b",
    "a*b",
    "a".repeat(256),
    "ok/" + "a".repeat(256),
  ];
  for (const title of invalid) {
    assertThrows(() => isValidNotePath(title), Error, undefined, title);
  }
});

Deno.test("isValidNotePath: segment of exactly 255 bytes is valid", () => {
  assert(isValidNotePath("a".repeat(255) + "/b"));
});

Deno.test("resolveInRoot: resolves inside root", async () => {
  const root = await Deno.makeTempDir();
  try {
    const resolved = resolveInRoot(root, "a/b/c.md");
    const expected = `${await Deno.realPath(root)}/a/b/c.md`;
    assertEquals(resolved, expected);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveInRoot: rejects traversal", async () => {
  const root = await Deno.makeTempDir();
  try {
    assertThrows(() => resolveInRoot(root, "../escape.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveInRoot: rejects symlink escape", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/external`);
    await Deno.mkdir(`${tmp}/root`);
    await Deno.symlink(`${tmp}/external`, `${tmp}/root/link`);
    assertThrows(() => resolveInRoot(`${tmp}/root`, "link/note.md"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveInRoot: allows symlink that stays inside", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const root = `${tmp}/root`;
    await Deno.mkdir(`${root}/real`, { recursive: true });
    await Deno.symlink(`${root}/real`, `${root}/link`);
    const resolved = resolveInRoot(root, "link/note.md");
    assertEquals(resolved, `${await Deno.realPath(root)}/real/note.md`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("camelCase converts snake_case", () => {
  assertEquals(camelCase("last_modified"), "lastModified");
  assertEquals(camelCase("title"), "title");
  assertEquals(camelCase("quick_access_hide"), "quickAccessHide");
});

Deno.test("hashPassword: format and round-trip", async () => {
  const stored = await hashPassword("hunter2");
  const [scheme, iterations, salt, digest] = stored.split("$");
  assertEquals(scheme, "pbkdf2_sha256");
  assertEquals(iterations, "100000");
  assertEquals(salt.length, 32); // 16 bytes hex
  assertEquals(digest.length, 64); // 32 bytes hex
  assert(await verifyPassword("hunter2", stored));
  assert(!(await verifyPassword("wrong", stored)));
});

Deno.test("verifyPassword: known vector from Python hashlib.pbkdf2_hmac", async () => {
  // hashlib.pbkdf2_hmac('sha256', b'correct horse battery staple',
  //                     bytes.fromhex(salt), 100000).hex()
  const salt = "00112233445566778899aabbccddeeff";
  const stored = `pbkdf2_sha256$100000$${salt}$` +
    "2a080fdedce213934a91e8142d2eb7165be949c295612ce4b7d87be90ae208b6";
  assert(await verifyPassword("correct horse battery staple", stored));
});

Deno.test("verifyPassword: malformed stored hashes return false", async () => {
  const bad = [
    "",
    "not-a-hash",
    "pbkdf2_sha256$notanumber$00$00",
    "pbkdf2_sha256$100000$zz$00",
    "pbkdf2_sha256$100000$00",
    "argon2$100000$00$00",
  ];
  for (const stored of bad) {
    assert(!(await verifyPassword("x", stored)), stored);
  }
});

Deno.test("verifyPassword: empty-string password verifies against its own hash", async () => {
  const stored = await hashPassword("");
  assert(await verifyPassword("", stored));
});

Deno.test("verifyPassword: rejects garbage without throwing", async () => {
  assertEquals(await verifyPassword("x", "garbage"), false);
});
