// SPDX-License-Identifier: LGPL-3.0-only
/** Pure instance-prefix codec shared by browser storage and authentication. */
export { readCredentialCookie as readIdentityCookie } from "./credentials.ts";

export function identityTokenScope(prefix: string) {
  if (
    prefix !== "" &&
    (!prefix.startsWith("/") || prefix.endsWith("/") || /[\s;,#?]/.test(prefix))
  ) {
    throw new TypeError("Invalid instance prefix.");
  }
  const suffix = prefix
    ? Array.from(
      new TextEncoder().encode(prefix),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
    : "root";
  return Object.freeze({
    key: `globnotes:session:${suffix}`,
    cookieName: `globnotes_session_${suffix}`,
    path: prefix || "/",
  });
}
export function identityCookie(
  name: string,
  token: string,
  path: string,
  clear = false,
): string {
  return `${name}=${encodeURIComponent(token)}; Path=${path}; SameSite=Strict${
    clear ? "; Max-Age=0" : ""
  }`;
}
