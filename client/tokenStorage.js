import { basePath, currentSlug } from "./vault.js";

function tokenKey() {
  const slug = currentSlug();
  return slug ? `token:${slug}` : "token";
}

function getCookieString(token) {
  const path = (basePath() || "") + "/" || "/";
  return `${tokenKey()}=${token}; Path=${path}; SameSite=Strict`;
}

export function storeToken(token, persist = false) {
  document.cookie = getCookieString(token);
  sessionStorage.setItem(tokenKey(), token);
  if (persist === true) {
    localStorage.setItem(tokenKey(), token);
  }
}

export function getStoredToken() {
  return sessionStorage.getItem(tokenKey());
}

export function loadStoredToken() {
  const token = localStorage.getItem(tokenKey());
  if (token != null) {
    storeToken(token, false);
  }
}

export function clearStoredToken() {
  sessionStorage.removeItem(tokenKey());
  localStorage.removeItem(tokenKey());
  document.cookie =
    getCookieString() + "; expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

export function isCurrentTokenStored() {
  const localToken = localStorage.getItem(tokenKey());
  if (localToken == null) {
    return false;
  }
  const sessionToken = sessionStorage.getItem(tokenKey());
  return localToken === sessionToken;
}
