const tokenStorageKey = "token";

function getBasePath() {
  // Cookie scope: the app root — the path prefix when served under a
  // sub-path, "/" otherwise. flatnotes read this from a <base> tag;
  // globnotes has no <base> and publishes the prefix in a meta tag instead.
  return document.querySelector('meta[name="globnotes-prefix"]')?.content ||
    "/";
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
}

export function getStoredToken() {
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
}

export function isCurrentTokenStored() {
  const localToken = localStorage.getItem(tokenStorageKey);
  if (localToken == null) {
    return false;
  }
  const sessionToken = sessionStorage.getItem(tokenStorageKey);
  return localToken === sessionToken;
}
