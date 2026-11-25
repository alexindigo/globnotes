// SPDX-License-Identifier: LGPL-3.0-only

/** Parse an input login without reading the account directory. */
export function parseLoginName(value: string): string | null {
  const login = value.trim().toLowerCase();
  const control = [...login].some((char) => {
    const point = char.codePointAt(0)!;
    return point < 32 || point === 127;
  });
  return !login || login === "guest" || control ? null : login;
}
