// SPDX-License-Identifier: LGPL-3.0-only
import QRCode from "qrcode";
import { totpSecretFromRawKey } from "./local.ts";
import {
  storedTotpManualSecret,
  type StoredTotpSecret,
} from "./credentials.ts";

export interface TotpEnrollmentBundle {
  readonly key: string;
  readonly secret: string;
  readonly uri: string;
  readonly qr: string;
}
export type EnrollmentRenderer = (uri: string) => Promise<string>;
/** Display label only: any accepted login, including one with an unpaired
 * surrogate, encodes. The stored login itself is never rewritten. */
function displayLabel(username: string): string {
  return encodeURIComponent(username.toWellFormed());
}
/** Presentation only. The credential aggregate owns issuance and generation. */
export async function renderAccountTotpEnrollment(
  username: string,
  candidate: StoredTotpSecret,
  render: EnrollmentRenderer = (uri) => QRCode.toDataURL(uri, { margin: 1 }),
): Promise<TotpEnrollmentBundle> {
  const secret = storedTotpManualSecret(candidate);
  const uri = `otpauth://totp/globnotes:${
    displayLabel(username)
  }?secret=${secret}&issuer=globnotes`;
  return Object.freeze({ key: secret, secret, uri, qr: await render(uri) });
}

/** Shared stateless enrolment. No active credential is changed or logged. */
export async function totpEnrolment(
  username: string,
): Promise<Record<string, string>> {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const key = [...crypto.getRandomValues(new Uint8Array(20))].map((byte) =>
    alphabet[byte % alphabet.length]
  ).join("");
  const secret = totpSecretFromRawKey(key);
  const uri = `otpauth://totp/globnotes:${
    displayLabel(username.trim() || "globnotes")
  }?secret=${secret}&issuer=globnotes`;
  return { key, secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1 }) };
}
