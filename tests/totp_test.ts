// SPDX-License-Identifier: LGPL-3.0-only

import { assertEquals } from "@std/assert";
import { encodeBase32 } from "@std/encoding/base32";
import { totp } from "otplib";
import { checkTotpCode } from "../server/auth/local.ts";
import { authenticatorCode } from "./helpers/totp.ts";

Deno.test("TOTP reference: RFC 6238 SHA1 test vectors", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  // https://www.rfc-editor.org/rfc/rfc6238#appendix-B
  for (
    const [seconds, expected] of [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ] as const
  ) {
    assertEquals(await authenticatorCode(secret, seconds * 1000, 8), expected);
  }
});

Deno.test("TOTP verification: authenticator key bytes, window and preset isolation", async (t) => {
  const originalNow = Date.now;
  const originalOptions = totp.options;
  const epoch = 1234567890_000;
  Date.now = () => epoch;
  totp.resetOptions();
  try {
    for (
      const raw of [
        "A",
        "ABCDE",
        "ABCDEFGHI",
        "ABCDEFGHIJ",
        "ABCDEFGHIJKLMNOP",
        "12345678901234567890",
        "A".repeat(32),
        "A".repeat(65),
        "caf\u00e9",
        "\ud83d\udd10",
      ]
    ) {
      await t.step(
        `standard code for ${new TextEncoder().encode(raw).length}-byte key`,
        async () => {
          const secret = encodeBase32(new TextEncoder().encode(raw)).replace(
            /=+$/,
            "",
          );
          const code = await authenticatorCode(secret, epoch);
          assertEquals(checkTotpCode(code, secret), true);
        },
      );
    }
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    await t.step(
      "previous/current/next accepted; outside window rejected",
      async () => {
        for (const offset of [-2, -1, 0, 1, 2]) {
          const code = await authenticatorCode(secret, epoch + offset * 30_000);
          assertEquals(checkTotpCode(code, secret), Math.abs(offset) <= 1);
        }
        for (const invalid of ["", "123", "abcdef", "1234567"]) {
          assertEquals(checkTotpCode(invalid, secret), false);
        }
      },
    );
    await t.step("checking does not mutate the shared preset", () => {
      assertEquals(totp.options, originalOptions);
    });
  } finally {
    Date.now = originalNow;
    totp.resetOptions();
    totp.options = originalOptions;
  }
});
