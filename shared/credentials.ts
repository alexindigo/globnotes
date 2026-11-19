// SPDX-License-Identifier: LGPL-3.0-only
/** Wire credential extraction shared by server auth and browser cookie codecs.
 * Presence is authoritative: malformed credentials never become absence. */
export function readCredentialCookie(
  header: string,
  name: string,
): string | null {
  let token: string | null = null;
  for (const part of header.split(";")) {
    const pair = part.trim(), separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator).trim();
    if (key !== name) continue;
    if (separator < 0 || pair.slice(0, separator) !== name || token !== null) {
      throw new TypeError("Invalid or ambiguous credential cookie.");
    }
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(separator + 1));
    } catch {
      throw new TypeError("Invalid credential cookie.");
    }
    if (!value || /\s/.test(value)) {
      throw new TypeError("Invalid credential cookie.");
    }
    token = value;
  }
  return token;
}

export function readCredential(
  authorization: string | null,
  cookies: string,
  cookieName: string,
): string | null {
  if (authorization !== null) {
    // RFC 6750: one or more ASCII SP separators, then b64token.
    const match = /^Bearer +([A-Za-z0-9._~+\/-]+=*)$/i.exec(authorization);
    if (!match || match[0] !== authorization) {
      throw new TypeError("Invalid authorization credential.");
    }
    return match[1];
  }
  return readCredentialCookie(cookies, cookieName);
}
