// SPDX-License-Identifier: LGPL-3.0-only
import { totp } from "otplib";
import { hotpCreateHmacKey, KeyEncodings } from "otplib/core.js";
import { decodeBase32, encodeBase32 } from "@std/encoding/base32";

export function totpSecretFromRawKey(rawKey: string): string {
  return encodeBase32(new TextEncoder().encode(rawKey)).replace(/=+$/, "");
}

/** Keep the authenticator's exact UTF-8 secret bytes and current +/-1 window.
 * checkDelta is the library's matched-window offset, not a guessed current step. */
function verifierFor(unpaddedSecret: string, epochMs?: number) {
  const verifier = totp.clone();
  verifier.options = {
    encoding: KeyEncodings.HEX,
    window: 1,
    step: 30,
    ...(epochMs === undefined ? {} : { epoch: epochMs }),
    createHmacKey: hotpCreateHmacKey,
  };
  const padded = unpaddedSecret.padEnd(
    Math.ceil(unpaddedSecret.length / 8) * 8,
    "=",
  );
  const key = [...decodeBase32(padded)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { verifier, key };
}
export function matchingTotpStep(
  code: string,
  unpaddedSecret: string,
  epochMs: number,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const { verifier, key } = verifierFor(unpaddedSecret, epochMs);
  const delta = verifier.checkDelta(code, key);
  return delta === null ? null : Math.floor(epochMs / 30_000) + delta;
}
export function checkTotpCode(code: string, unpaddedSecret: string): boolean {
  const { verifier, key } = verifierFor(unpaddedSecret);
  return verifier.check(code, key);
}
