// SPDX-License-Identifier: LGPL-3.0-only

/** Obtain a real token through the active route; callers choose which account
 * to use. Never promotes a guest fixture or reads a stored signing key. */
export async function fixtureSignIn(
  baseUrl: string,
  person: { login: string; password: string; totp?: string },
  prefix = "",
  signal?: AbortSignal,
) {
  const response = await fetch(`${baseUrl}${prefix}/_/api/token`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: person.login,
      password: person.password,
      ...(person.totp ? { totp: person.totp } : {}),
    }),
  });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error(
      `Fixture account sign-in failed (HTTP ${response.status}).`,
    );
  }
  return result.access_token as string;
}
