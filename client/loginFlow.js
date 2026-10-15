// SPDX-License-Identifier: LGPL-3.0-only
import { apiErrorHandler, getToken } from "./api.js";
import { authTypes } from "./constants.js";
import { getToastOptions } from "./helpers.js";
import { storeToken } from "./tokenStorage.js";

export function loginError(error) {
  return error.response?.status === 401
    ? getToastOptions("Please check your credentials and try again.", "Login Failed", "error")
    : null;
}

/** Form inputs stay in the view; token ownership and login decisions live here. */
export function createLoginFlow({
  credentials, clearCredentials, redirect, navigate, toast,
  requestToken = getToken, persistToken = storeToken, reportError = apiErrorHandler,
} = {}) {
  function init(authType) {
    if (authType === authTypes.none) navigate({ name: "home" });
  }

  function logIn() {
    const { username, password, totp } = credentials();
    return requestToken(username, password, totp)
      .then((token) => {
        // Read the current checkbox and redirect when the request acknowledges.
        persistToken(token, credentials().rememberMe);
        navigate(redirect() || { name: "home" });
      })
      .catch((error) => {
        clearCredentials();
        const message = loginError(error);
        if (message) toast.add(message);
        else reportError(error, toast);
      });
  }

  return { init, logIn };
}
