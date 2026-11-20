// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeBase32, encodeBase32 } from "@std/encoding/base32";
import {
  decodeStoredAuthenticator,
  decodeStoredTotpSecret,
  matchingStoredTotpStep,
  sameStoredTotpSecret,
  serializeStoredTotpSecret,
  type StoredAuthenticator,
  storedTotpManualSecret,
  type StoredTotpSecret,
} from "../server/auth/credentials.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { authenticatorCode } from "./helpers/totp.ts";

const NOW = 1_800_000_000_000;
const base32 = (bytes: Uint8Array) => encodeBase32(bytes).replace(/=+$/, "");
const raw = (text: string) => decodeStoredTotpSecret(text);

Deno.test("stored secret: opaque provenance rejects forged and cloned values", () => {
  const secret = raw("key");
  assert(Object.isFrozen(secret));
  assertEquals(Object.keys(secret), []);
  assertEquals(JSON.stringify(secret), "{}");
  for (const forged of [{}, { ...secret }, structuredClone(secret)]) {
    assertThrows(
      () => sameStoredTotpSecret(secret, forged as StoredTotpSecret),
      IdentityStateError,
    );
    assertThrows(
      () => matchingStoredTotpStep("123456", forged as StoredTotpSecret, NOW),
      IdentityStateError,
    );
    assertThrows(
      () => serializeStoredTotpSecret(forged as StoredTotpSecret),
      IdentityStateError,
    );
  }
  // Type-level control, never executed. Runtime controls above also reject casts.
  const typeControls = () => {
    // @ts-expect-error Plain DTOs cannot stand in for the opaque value.
    const forged: StoredTotpSecret = { key: "key" };
    void forged;
    // @ts-expect-error The absent branch has no replay-floor field.
    const absent: StoredAuthenticator = { kind: "none", lastTotpStep: 1 };
    void absent;
  };
  void typeControls;
});

Deno.test("stored secret: raw history and provenance serialize without normalization", async () => {
  for (
    const text of [
      "key",
      "\0",
      "key\0",
      "caf\u00e9",
      "\ud800",
      "\ufffd",
      "A".repeat(32),
      "x".repeat(65),
    ]
  ) {
    for (const encoding of [undefined, null]) {
      const secret = decodeStoredTotpSecret(text, encoding);
      const serialized = serializeStoredTotpSecret(secret);
      assertEquals(serialized, {
        key: text,
        ...(encoding === undefined ? {} : { encoding }),
      });
      assert(Object.isFrozen(serialized));
      assertEquals(
        storedTotpManualSecret(secret),
        base32(new TextEncoder().encode(text)),
      );
      const code = await authenticatorCode(
        base32(new TextEncoder().encode(text)),
        NOW,
      );
      assertEquals(matchingStoredTotpStep(code, secret, NOW), NOW / 30_000);
    }
  }
  assert(sameStoredTotpSecret(raw("\ud800"), raw("\ufffd")));
  const key = "A".repeat(32);
  const marked = decodeStoredTotpSecret(key, "base32");
  assertEquals(serializeStoredTotpSecret(marked), { key, encoding: "base32" });
  assertEquals(
    decodeBase32(storedTotpManualSecret(marked)),
    new Uint8Array(20),
  );
  assert(!sameStoredTotpSecret(marked, raw(key)));
});

Deno.test("stored secret: SHA-1 HMAC trailing-zero aliases include the legacy-to-marked boundary", async () => {
  const text = "1234567890123456789";
  const marked = decodeStoredTotpSecret(
    base32(new TextEncoder().encode(text + "\0")),
    "base32",
  );
  for (
    const [left, right] of [[raw("key"), raw("key\0")], [raw(text), marked], [
      raw("x".repeat(63)),
      raw("x".repeat(63) + "\0"),
    ]]
  ) {
    assert(sameStoredTotpSecret(left, right));
    for (const epoch of [NOW - 30_000, NOW, NOW + 30_000]) {
      const code = await authenticatorCode(storedTotpManualSecret(left), epoch);
      assertEquals(
        await authenticatorCode(storedTotpManualSecret(right), epoch),
        code,
      );
      assertEquals(matchingStoredTotpStep(code, right, NOW), epoch / 30_000);
    }
  }
});

Deno.test("stored secret: long keys reduce before padding, never across the block boundary", async () => {
  const text = "x".repeat(65);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)),
  );
  const long = raw(text),
    reduced = decodeStoredTotpSecret(base32(digest), "base32");
  assert(sameStoredTotpSecret(long, reduced));
  const boundary = "x".repeat(64);
  const boundaryHash = new Uint8Array(
    await crypto.subtle.digest("SHA-1", new TextEncoder().encode(boundary)),
  );
  assert(
    !sameStoredTotpSecret(
      raw(boundary),
      decodeStoredTotpSecret(base32(boundaryHash), "base32"),
    ),
    "a 64-byte key must not be reduced",
  );
  for (const epoch of [NOW, NOW + 30_000]) {
    assertEquals(
      await authenticatorCode(storedTotpManualSecret(long), epoch),
      await authenticatorCode(base32(digest), epoch),
    );
  }
  for (
    const [left, right] of [["x".repeat(64), "x".repeat(64) + "\0"], [
      text,
      text + "\0",
    ], ["key", "kez"]]
  ) {
    assert(!sameStoredTotpSecret(raw(left), raw(right)));
    assert(
      (await authenticatorCode(storedTotpManualSecret(raw(left)), NOW)) !==
        (await authenticatorCode(storedTotpManualSecret(raw(right)), NOW)),
    );
  }
});

Deno.test("stored secret: no-authenticator cannot carry a replay floor or marked key", () => {
  assertEquals(decodeStoredAuthenticator(null, undefined, null), {
    kind: "none",
  });
  assertEquals(decodeStoredAuthenticator(null, null, null), { kind: "none" });
  for (
    const [key, encoding, floor] of [
      [null, undefined, 0],
      [null, "base32", null],
      ["key", undefined, -1],
      ["key", undefined, 1.5],
      ["key", undefined, undefined],
    ]
  ) {
    assertThrows(
      () => decodeStoredAuthenticator(key, encoding, floor),
      IdentityStateError,
    );
  }
  for (
    const key of [
      "",
      "short",
      "a".repeat(32),
      "A".repeat(31),
      "A".repeat(33),
      "A".repeat(31) + "=",
      "0".repeat(32),
    ]
  ) {
    assertThrows(
      () => decodeStoredTotpSecret(key, "base32"),
      IdentityStateError,
    );
  }
  assertThrows(() => decodeStoredTotpSecret("key", "utf8"), IdentityStateError);
  const secret = raw("key");
  for (const code of ["", "12345", "1234567", "abcdef"]) {
    assertEquals(matchingStoredTotpStep(code, secret, NOW), null);
  }
  assertEquals(matchingStoredTotpStep("123456", secret, NOW), null);
});
