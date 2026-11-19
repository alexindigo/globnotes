// SPDX-License-Identifier: LGPL-3.0-only
import QRCode from "qrcode";
import { encodeBase32 } from "@std/encoding/base32";
import { TOTP_KEY_BYTES } from "./credentials.ts";

/** Shared stateless enrolment. No active credential is changed or logged. */
export async function totpEnrolment(
  username: string,
): Promise<Record<string, string>> {
  const key = encodeBase32(
    crypto.getRandomValues(new Uint8Array(TOTP_KEY_BYTES)),
  );
  const secret = key;
  const uri = `otpauth://totp/globnotes:${
    encodeURIComponent(username.trim() || "globnotes")
  }?secret=${secret}&issuer=globnotes`;
  return { key, secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1 }) };
}
