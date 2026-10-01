// SPDX-License-Identifier: LGPL-3.0-only

import { decodeBase32 } from "@std/encoding/base32";

/** Test-side RFC 6238 reference, independent of otplib and the verifier.
 * The input is the base32 secret a real authenticator reads from the QR. */
export async function authenticatorCode(
  secret: string,
  epochMs = Date.now(),
  digits = 6,
): Promise<string> {
  const padded = secret.padEnd(Math.ceil(secret.length / 8) * 8, "=");
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(padded),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(
    0,
    BigInt(Math.floor(epochMs / 30_000)),
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = new DataView(digest.buffer).getUint32(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}
