// SPDX-License-Identifier: LGPL-3.0-only
import { totp } from "otplib";
import { hotpCreateHmacKey, KeyEncodings } from "otplib/core.js";
import { decodeBase32, encodeBase32 } from "@std/encoding/base32";
import { createHash } from "node:crypto";
import { IdentityStateError, integer } from "./records.ts";

declare const storedSecretBrand: unique symbol;
/** Process-local decoded value, not a credential proof or a writable DTO. */
export interface StoredTotpSecret {
  readonly [storedSecretBrand]: true;
}
export type TotpKeyEncoding = "base32" | null;
interface SecretPayload {
  readonly stored: Readonly<{ key: string; encoding?: TotpKeyEncoding }>;
  readonly verifierSecret: string;
  readonly hmacIdentity: string;
}
const secrets = new WeakMap<StoredTotpSecret, SecretPayload>();
const unpadded = (bytes: Uint8Array) => encodeBase32(bytes).replace(/=+$/, "");
function payload(secret: StoredTotpSecret): SecretPayload {
  const value = secrets.get(secret);
  if (!value) throw new IdentityStateError();
  return value;
}

/** Stored history has its own lane: never infer encoding from appearance, or
 * apply the marked/new-key predicate to unmarked historical UTF-8 text. */
export function decodeStoredTotpSecret(
  key: unknown,
  encoding?: unknown,
): StoredTotpSecret {
  if (
    typeof key !== "string" || key.length === 0 ||
    (encoding !== undefined && encoding !== null && encoding !== "base32") ||
    (encoding === "base32" && !/^[A-Z2-7]{32}$/.test(key))
  ) throw new IdentityStateError();
  const bytes = encoding === "base32"
    ? decodeBase32(key)
    : new TextEncoder().encode(key);
  // SHA-1 HMAC reduces only keys LONGER than the 64-byte block. Capture the
  // immutable effective key here, not in the repository's final comparison.
  const effective = bytes.length > 64
    ? createHash("sha1").update(bytes).digest()
    : bytes;
  const block = new Uint8Array(64);
  block.set(effective);
  const secret = Object.freeze(Object.create(null)) as StoredTotpSecret;
  secrets.set(
    secret,
    Object.freeze({
      stored: Object.freeze({
        key,
        ...(encoding === undefined ? {} : { encoding }),
      }),
      verifierSecret: unpadded(bytes),
      hmacIdentity: [...block].map((b) => b.toString(16).padStart(2, "0")).join(
        "",
      ),
    }),
  );
  return secret;
}
export function serializeStoredTotpSecret(secret: StoredTotpSecret) {
  return payload(secret).stored;
}
export function sameStoredTotpSecret(
  left: StoredTotpSecret,
  right: StoredTotpSecret,
): boolean {
  return payload(left).hmacIdentity === payload(right).hmacIdentity;
}
/** Explicit QR/manual disclosure; ordinary opaque values expose no key fields. */
export function storedTotpManualSecret(secret: StoredTotpSecret): string {
  return payload(secret).verifierSecret;
}
export function matchingStoredTotpStep(
  code: string,
  secret: StoredTotpSecret,
  epochMs: number,
): number | null {
  return matchingTotpStep(code, payload(secret).verifierSecret, epochMs);
}
export function checkStoredTotpCode(
  code: string,
  secret: StoredTotpSecret,
): boolean {
  return checkTotpCode(code, payload(secret).verifierSecret);
}
export type StoredAuthenticator =
  | Readonly<{ kind: "none" }>
  | Readonly<{
    kind: "totp";
    secret: StoredTotpSecret;
    lastTotpStep: number | null;
  }>;
export function decodeStoredAuthenticator(
  key: unknown,
  encoding: unknown,
  lastTotpStep: unknown,
): StoredAuthenticator {
  if (key === null) {
    if (
      lastTotpStep !== null || (encoding !== undefined && encoding !== null)
    ) {
      throw new IdentityStateError();
    }
    return Object.freeze({ kind: "none" });
  }
  if (lastTotpStep !== null && !integer(lastTotpStep)) {
    throw new IdentityStateError();
  }
  return Object.freeze({
    kind: "totp",
    secret: decodeStoredTotpSecret(key, encoding),
    lastTotpStep: lastTotpStep as number | null,
  });
}

/** Compatibility producer for the still-active raw enrollment workflows. */
export function totpSecretFromRawKey(rawKey: string): string {
  return unpadded(new TextEncoder().encode(rawKey));
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
