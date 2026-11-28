import { readPathPrefix } from "./pathPrefix.js";
import { ref } from "vue";
import { identityCookie, identityTokenScope } from "../shared/identity_token.ts";

/** Instance-scoped storage; never imports, migrates or deletes v2 credentials. */
export function createIdentityTokenStorage({ prefix = readPathPrefix(), local = localStorage,
  session = sessionStorage, setCookie = value => { document.cookie = value; }, storageEvents = window } = {}) {
  const scope = identityTokenScope(prefix), revision = ref(0);
  let remembered = session.getItem(scope.key) !== null && session.getItem(scope.key) === local.getItem(scope.key);
  function storeToken(token, persist = false) {
    if (typeof token !== "string" || !token || /\s/.test(token)) throw new TypeError("Invalid session token.");
    const changed = session.getItem(scope.key) !== token;
    session.setItem(scope.key, token);
    if (persist) local.setItem(scope.key, token);
    else local.removeItem(scope.key);
    remembered = persist;
    setCookie(identityCookie(scope.cookieName, token, scope.path));
    if (changed) revision.value++;
  }
  function getStoredToken() { revision.value; return session.getItem(scope.key); }
  function clearStoredToken() {
    session.removeItem(scope.key); local.removeItem(scope.key);
    remembered = false;
    setCookie(identityCookie(scope.cookieName, "", scope.path, true)); revision.value++;
  }
  return Object.freeze({ scope, storeToken, getStoredToken, clearStoredToken,
    acceptSharedSignIn(token) {
      if (local.getItem(scope.key) !== token) return false;
      // The sign-in tab already owns the shared storage and cookie. This tab
      // updates only its request credential and never republishes the event.
      session.setItem(scope.key, token); remembered = true; revision.value++;
      return true;
    },
    subscribeSharedSignIn(receive) {
      const changed = event => {
        const token = event.newValue;
        if (event.storageArea === local && event.key === scope.key && typeof token === "string" && token &&
            token === local.getItem(scope.key) && token !== getStoredToken()) receive(token);
      };
      storageEvents.addEventListener("storage", changed);
      return () => storageEvents.removeEventListener("storage", changed);
    },
    capture() {
      const generation = revision.value;
      return () => revision.value === generation;
    },
    loadStoredToken() { const token = local.getItem(scope.key); if (token !== null) storeToken(token, true); },
    isCurrentTokenStored() { return getStoredToken() !== null && remembered; },
  });
}

let storage;
export function activeTokenStorage() { return storage ??= createIdentityTokenStorage(); }
export const storeToken = (token, persist) => activeTokenStorage().storeToken(token, persist);
export const getStoredToken = () => activeTokenStorage().getStoredToken();
export const loadStoredToken = () => activeTokenStorage().loadStoredToken();
export const clearStoredToken = () => activeTokenStorage().clearStoredToken();
export const isCurrentTokenStored = () => activeTokenStorage().isCurrentTokenStored();
