// SPDX-License-Identifier: LGPL-3.0-only
import { totp } from "otplib";
import { hotpCreateHmacKey, KeyEncodings } from "otplib/core.js";
import { decodeBase32 } from "@std/encoding/base32";

export const TOTP_KEY_BYTES = 20;

/** One encoding of one fixed-length SHA-1 key, never arbitrary raw text. */
export function validTotpKey(value: unknown): value is string {
  return typeof value === "string" && value.length === TOTP_KEY_BYTES * 8 / 5 &&
    /^[A-Z2-7]+$/.test(value);
}

export function decodeTotpKey(key: string): Uint8Array {
  if (!validTotpKey(key)) throw new TypeError("Invalid authenticator key.");
  return decodeBase32(key);
}

/** Keep the authenticator's exact key bytes and current +/-1 window.
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
  const key = [...decodeTotpKey(unpaddedSecret)]
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
