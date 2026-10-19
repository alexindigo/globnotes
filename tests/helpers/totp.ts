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

export const TOTP_STEP_MS = 30_000;

/** The 30-second step a time falls in. */
export const totpStep = (epochMs = Date.now()): number =>
  Math.floor(epochMs / TOTP_STEP_MS);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Returns a "now" a test can derive window codes from without racing the
 * wall clock. The verifier accepts the current step ±1 and rejects a replay of
 * the last accepted code, so a test that assumes "the previous step" is still
 * valid, or differs from a code it already consumed, fails whenever a step
 * boundary passes mid-test. This waits out (at most one step):
 * - the last `marginMs` of a step, so steps −1..+1 stay valid while the
 *   request is in flight;
 * - the step right after `consumedAtStep`, where the previous step's code is
 *   the consumed one. */
export async function settledTotpNow(
  { consumedAtStep, marginMs = 5_000 }: {
    consumedAtStep?: number;
    marginMs?: number;
  } = {},
): Promise<number> {
  for (;;) {
    const now = Date.now(), step = totpStep(now);
    const remaining = (step + 1) * TOTP_STEP_MS - now;
    if (remaining > marginMs && step !== (consumedAtStep ?? NaN) + 1) {
      return now;
    }
    await sleep(remaining + 50);
  }
}

/** A code the verifier accepts now that is not one already consumed. Prefers
 * the current step, then the next, then the previous: the first two stay valid
 * if a step boundary passes before the request arrives. */
export async function unusedWindowCode(
  secret: string,
  consumed: Iterable<string>,
): Promise<string> {
  const used = new Set(consumed), now = await settledTotpNow();
  for (const offset of [0, 1, -1]) {
    const code = await authenticatorCode(secret, now + offset * TOTP_STEP_MS);
    if (!used.has(code)) return code;
  }
  throw new Error("Every code in the verifier window was already consumed");
}
