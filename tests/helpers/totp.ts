// SPDX-License-Identifier: LGPL-3.0-only

import { decodeBase32 } from "@std/encoding/base32";

const requireFixtureTime = (value: unknown): number => {
  if (typeof value !== "number") {
    throw new TypeError("Explicit fixture time required");
  }
  return value;
};

/** Test-side RFC 6238 reference, independent of otplib and the verifier.
 * The input is the base32 secret a real authenticator reads from the QR. */
export async function authenticatorCode(
  secret: string,
  epochMs: number,
  digits = 6,
): Promise<string> {
  epochMs = requireFixtureTime(epochMs);
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

export const TOTP_STEP_MS = 30_000;

/** The 30-second step a time falls in. */
export const totpStep = (epochMs: number): number =>
  Math.floor(requireFixtureTime(epochMs) / TOTP_STEP_MS);

/** A code the verifier accepts that is not already consumed. Prefer current,
 * then next, then previous. An owned fixture clock can supply both generation
 * and verification time: only the intersection of their windows is eligible,
 * without waiting on the wall clock. */
export async function unusedWindowCode(
  secret: string,
  consumed: Iterable<string>,
  epochMs: number,
  verifiedAtMs?: number,
): Promise<string> {
  const used = new Set(consumed), now = requireFixtureTime(epochMs);
  const verificationStep = totpStep(verifiedAtMs ?? now);
  for (const offset of [0, 1, -1]) {
    if (Math.abs(totpStep(now) + offset - verificationStep) > 1) continue;
    const code = await authenticatorCode(secret, now + offset * TOTP_STEP_MS);
    if (!used.has(code)) return code;
  }
  throw new Error("Every code in the verifier window was already consumed");
}
