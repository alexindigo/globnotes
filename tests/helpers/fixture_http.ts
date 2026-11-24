// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureSignIn, type TestServer } from "./boot.ts";

/** Tests select named Admin only for the requests acting in that role. */
export async function fixtureAdmin(server: TestServer, prefix = "") {
  const token = await fixtureSignIn(server.baseUrl, {
    login: "alice",
    password: "password",
  }, prefix);
  const headers = { authorization: `Bearer ${token}` };
  return {
    token,
    headers,
    fetch(url: string, init?: RequestInit) {
      const combined = new Headers(init?.headers);
      combined.set("authorization", headers.authorization);
      return fetch(url, { ...init, headers: combined });
    },
  };
}
