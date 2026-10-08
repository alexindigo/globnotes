// SPDX-License-Identifier: LGPL-3.0-only
import QRCode from "qrcode";
import { totpSecretFromRawKey } from "./local.ts";

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
    encodeURIComponent(username.trim() || "globnotes")
  }?secret=${secret}&issuer=globnotes`;
  return { key, secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1 }) };
}
