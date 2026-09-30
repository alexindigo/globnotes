// SPDX-License-Identifier: LGPL-3.0-only

/** POST /_/api/setup/totp-enrolment — mint a TOTP key for the first-run
 * setup wizard. Public by design (the setup endpoints are), but only
 * while setup is pending. Stateless: nothing is stored server-side; the
 * wizard shows the bundle and the code entered at submit proves the user
 * recorded the key. */

import { HttpError } from "@pathfinder/pathfinder";
import QRCode from "qrcode";

import { totpSecretFromRawKey } from "@server/auth/local.ts";
import { logger } from "@server/logger.ts";
import { state } from "@server/state.ts";

export const auth = false;

const KEY_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_LENGTH = 20;

export default async function (
  request,
): Promise<Record<string, string>> {
  if (!state.config.setupRequired) {
    throw new HttpError(409, "Setup has already been completed.");
  }
  const data = (await request.body.json().catch(() => ({}))) as {
    username?: string;
  };
  const username = (data.username ?? "").trim() || "globnotes";

  // Raw text, same form an env var would carry — the stored config will
  // hold this verbatim, indistinguishable from GLOBNOTES_TOTP_KEY.
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  const key = [...bytes].map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length])
    .join("");
  const secret = totpSecretFromRawKey(key);
  const uri = `otpauth://totp/globnotes:${encodeURIComponent(username)}` +
    `?secret=${secret}&issuer=globnotes`;
  const qr = await QRCode.toDataURL(uri, { margin: 1 });

  logger.info("TOTP enrolment key minted for the setup wizard.");
  // key  = storage form (echoed back at submit; config.json verbatim);
  // secret = enrolment form (base32, what an authenticator types manually).
  return { key, secret, uri, qr };
}
