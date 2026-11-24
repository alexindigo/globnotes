// SPDX-License-Identifier: LGPL-3.0-only
import QRCode from "qrcode";
import {
  createTotpCandidate,
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

/** Presentation convenience for fixtures. This does not issue enrollment
 * authority: production confirmation requires the current service candidate. */
export async function totpEnrolment(
  username: string,
): Promise<TotpEnrollmentBundle> {
  return await renderAccountTotpEnrollment(username, createTotpCandidate());
}
