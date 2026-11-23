import { readPathPrefix } from "./pathPrefix.js";
import { ref } from "vue";
import { identityCookie, identityTokenScope } from "../shared/identity_token.ts";

/** Prepared instance adapter; never imports, migrates or deletes v2 credentials. */
export function createIdentityTokenStorage({ prefix = readPathPrefix(), local = localStorage,
  session = sessionStorage, setCookie = value => { document.cookie = value; } } = {}) {
  const scope = identityTokenScope(prefix), revision = ref(0);
  function storeToken(token, persist = false) {
    if (typeof token !== "string" || !token || /\s/.test(token)) throw new TypeError("Invalid session token.");
    session.setItem(scope.key, token);
    if (persist) local.setItem(scope.key, token);
    else local.removeItem(scope.key);
    setCookie(identityCookie(scope.cookieName, token, scope.path));
    revision.value++;
  }
  function getStoredToken() { revision.value; return session.getItem(scope.key); }
  function clearStoredToken() {
    session.removeItem(scope.key); local.removeItem(scope.key);
    setCookie(identityCookie(scope.cookieName, "", scope.path, true)); revision.value++;
  }
  return Object.freeze({ scope, storeToken, getStoredToken, clearStoredToken,
    loadStoredToken() { const token = local.getItem(scope.key); if (token !== null) storeToken(token, true); },
    isCurrentTokenStored() { const current = getStoredToken(); return current !== null && current === local.getItem(scope.key); },
  });
}

const tokenStorageKey = "token";
const revision = ref(0);

function getBasePath() {
  // Cookie scope: the app root — the path prefix when served under a
  // sub-path, "/" otherwise. flatnotes read this from a <base> tag;
  // globnotes has no <base> and publishes the prefix in a meta tag instead.
  return readPathPrefix() || "/";
}

function getCookieString(token) {
  const basePath = getBasePath();
  return `${tokenStorageKey}=${token}; Path=${basePath}; SameSite=Strict`;
}

export function storeToken(token, persist = false) {
  document.cookie = getCookieString(token);
  sessionStorage.setItem(tokenStorageKey, token);
  if (persist === true) {
    localStorage.setItem(tokenStorageKey, token);
  }
  revision.value++;
}

export function getStoredToken() {
  // Track writes by this capability owner without duplicating token storage.
  revision.value;
  return sessionStorage.getItem(tokenStorageKey);
}

export function loadStoredToken() {
  const token = localStorage.getItem(tokenStorageKey);
  if (token != null) {
    storeToken(token, false);
  }
}

export function clearStoredToken() {
  sessionStorage.removeItem(tokenStorageKey);
  localStorage.removeItem(tokenStorageKey);
  document.cookie =
    getCookieString() + "; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  revision.value++;
}

export function isCurrentTokenStored() {
  const localToken = localStorage.getItem(tokenStorageKey);
  if (localToken == null) {
    return false;
  }
  const sessionToken = sessionStorage.getItem(tokenStorageKey);
  return localToken === sessionToken;
}
