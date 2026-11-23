import { afterEach, expect, it } from "vitest";
import { nextTick, watch } from "vue";
import { createIdentityTokenStorage } from "../tokenStorage.js";
import { identityTokenScope, readIdentityCookie } from "../../shared/identity_token.ts";

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });
it("two prefixes own distinct HTTP-compatible credentials without importing or deleting v2", () => {
  localStorage.setItem("token", "legacy-secret"); sessionStorage.setItem("token", "legacy-tab");
  const cookies = [];
  const one = createIdentityTokenStorage({ prefix: "/one", setCookie: value => cookies.push(value) });
  const two = createIdentityTokenStorage({ prefix: "/two", setCookie: value => cookies.push(value) });
  one.loadStoredToken(); two.loadStoredToken();
  expect([one.getStoredToken(), two.getStoredToken()]).toEqual([null, null]);
  one.storeToken("one.jwt", true); two.storeToken("two.jwt", true);
  expect([one.getStoredToken(), two.getStoredToken()]).toEqual(["one.jwt", "two.jwt"]);
  expect(cookies).toEqual([
    `${one.scope.cookieName}=one.jwt; Path=/one; SameSite=Strict`,
    `${two.scope.cookieName}=two.jwt; Path=/two; SameSite=Strict`,
  ]);
  expect(readIdentityCookie(cookies[0], one.scope.cookieName)).toBe("one.jwt");
  expect(readIdentityCookie(cookies[0], two.scope.cookieName)).toBeNull();
  one.clearStoredToken();
  expect(cookies.at(-1)).toBe(`${one.scope.cookieName}=; Path=/one; SameSite=Strict; Max-Age=0`);
  expect([two.getStoredToken(), localStorage.getItem("token"), sessionStorage.getItem("token")]).toEqual(["two.jwt", "legacy-secret", "legacy-tab"]);
});
it("root and prefix names are distinct; malformed matching credentials reject", () => {
  expect(identityTokenScope("").cookieName).not.toBe(identityTokenScope("/root").cookieName);
  expect(identityTokenScope("/a").key).not.toBe(identityTokenScope("/ab").key);
  expect(() => identityTokenScope("/bad;path")).toThrow(new TypeError("Invalid instance prefix."));
  for (const cookie of ["session=one; session=two", "session=%xx", "session", "other; session", "session=good; session", "session; session=good", "session =good", "session=", "session=%20"]) {
    expect(() => readIdentityCookie(cookie, "session")).toThrow();
  }
  expect(readIdentityCookie("other; session-extra; another=%xx", "session")).toBeNull();
  expect(readIdentityCookie("other; session=abc%2B%2F%3D", "session")).toBe("abc+/=");
});
it("remembered replacement, reload, logout and reactive delivery stay within one instance", async () => {
  const tokens = createIdentityTokenStorage({ prefix: "/one", setCookie() {} }), seen = [];
  const stop = watch(tokens.getStoredToken, value => seen.push(value));
  try {
    tokens.storeToken("first", true); await nextTick();
    tokens.storeToken("second", false); await nextTick();
    expect(tokens.isCurrentTokenStored()).toBe(false); expect(localStorage.getItem(tokens.scope.key)).toBeNull();
    tokens.clearStoredToken(); await nextTick(); tokens.loadStoredToken();
    expect(tokens.getStoredToken()).toBeNull(); expect(seen).toEqual(["first", "second", null]);
  } finally { stop(); }
});
