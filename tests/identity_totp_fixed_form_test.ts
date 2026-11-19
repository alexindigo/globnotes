// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeBase32, encodeBase32 } from "@std/encoding/base32";
import { matchingTotpStep, validTotpKey } from "../server/auth/credentials.ts";
import { totpEnrolment } from "../server/auth/totp_enrolment.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import { identityAccount, identityFixture } from "./helpers/identity.ts";
import { authenticatorCode } from "./helpers/totp.ts";
import { createUuid } from "../shared/uuid.ts";

const bytes = new Uint8Array(20).fill(0x61);
const key = encodeBase32(bytes);
const zeroPadded = encodeBase32(new Uint8Array([...bytes, 0])).replace(
  /=+$/,
  "",
);
const invalid = [
  "key",
  "key\0",
  key + "\0",
  key.toLowerCase(),
  key + "=",
  " " + key,
  key + "\n",
  key.slice(1),
  key + "A",
  "0" + key.slice(1),
  "8" + key.slice(1),
  zeroPadded,
  encodeBase32(bytes.slice(1)).replace(/=+$/, ""),
  encodeBase32(new Uint8Array(64).fill(1)).replace(/=+$/, ""),
  "\ud800",
  "",
  null,
  17,
];

for (const value of invalid) {
  Deno.test(`fixed TOTP: rejects noncanonical or wrong-length key ${JSON.stringify(value)}`, () => {
    assertEquals(validTotpKey(value), false);
  });
}

Deno.test("fixed TOTP: enrollment exposes one canonical encoding of exactly 20 random bytes", async () => {
  const random = crypto.getRandomValues.bind(crypto);
  const requests: number[] = [];
  crypto.getRandomValues = ((array: ArrayBufferView) => {
    requests.push(array.byteLength);
    assert(array instanceof Uint8Array);
    array.set(bytes);
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    const candidate = await totpEnrolment("alice");
    assertEquals(requests, [20]);
    assertEquals(candidate.key, key);
    assertEquals(candidate.secret, key);
    assertEquals(decodeBase32(candidate.key), bytes);
    assertEquals(new URL(candidate.uri).searchParams.get("secret"), key);
    assert(candidate.qr.startsWith("data:image/png"));
  } finally {
    crypto.getRandomValues = random;
  }
});

Deno.test("fixed TOTP: HMAC zero-padding alias cannot enter the repository or lower its replay floor", () =>
  identityFixture(async (root) => {
    const now = 1_800_000_000_000;
    assertEquals(
      await authenticatorCode(key, now),
      await authenticatorCode(zeroPadded, now),
    );
    const accounts = new AccountRepository(root);
    const account = accounts.create(
      identityAccount({ totpKey: key, lastTotpStep: 100 }),
    );
    const before = Deno.readTextFileSync(`${root}/accounts.json`);
    for (const alias of [zeroPadded, key + "\0"]) {
      assertThrows(() =>
        accounts.changeCredentials(
          account.id,
          0,
          { totpKey: alias },
          createUuid(),
          undefined,
          99,
        )
      );
      assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), before);
      assertEquals(accounts.byId(account.id)?.lastTotpStep, 100);
    }
  }));

Deno.test("fixed TOTP: verifier rejects alternate key lengths, not just their submitted text", async () => {
  const now = 1_800_000_000_000;
  const code = await authenticatorCode(key, now);
  assertEquals(matchingTotpStep(code, key, now), now / 30_000);
  assertThrows(() => matchingTotpStep(code, zeroPadded, now));
});

for (const path of ["create", "import", "change", "reload"] as const) {
  for (
    const invalidKey of [
      key.toLowerCase(),
      key + "=",
      key.slice(1),
      zeroPadded,
      key + "\0",
    ]
  ) {
    Deno.test(`fixed TOTP: ${path} rejects ${JSON.stringify(invalidKey)} without rewriting state`, () =>
      identityFixture((root) => {
        const accounts = new AccountRepository(root);
        if (path === "create" || path === "import") {
          assertThrows(() =>
            path === "create"
              ? accounts.create(identityAccount({ totpKey: invalidKey }))
              : accounts.importAccount(identityAccount({ totpKey: invalidKey }))
          );
          assertEquals(accounts.capture().persistence.raw, null);
          return;
        }
        const account = accounts.create(
          identityAccount({ totpKey: key, lastTotpStep: 100 }),
        );
        const before = Deno.readTextFileSync(`${root}/accounts.json`);
        if (path === "change") {
          assertThrows(() =>
            accounts.changeCredentials(
              account.id,
              0,
              { totpKey: invalidKey },
              createUuid(),
              undefined,
              99,
            )
          );
          assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), before);
          assertEquals(accounts.byId(account.id)?.lastTotpStep, 100);
        } else {
          const invalidState = before.replace(
            key,
            invalidKey.replaceAll("\0", "\\u0000"),
          );
          Deno.writeTextFileSync(`${root}/accounts.json`, invalidState);
          assertThrows(() => new AccountRepository(root));
          assertEquals(
            Deno.readTextFileSync(`${root}/accounts.json`),
            invalidState,
          );
        }
      }));
  }
}
