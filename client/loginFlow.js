// SPDX-License-Identifier: LGPL-3.0-only
import { apiErrorHandler, getToken } from "./api.js";
import { authTypes } from "./constants.js";
import { getToastOptions } from "./helpers.js";
import { storeToken } from "./tokenStorage.js";
import { createOperationOwner } from "./operationOwner.js";

export function createIdentityLoginFlow({ session, ...adapters }) {
  return createLoginFlow({ ...adapters, identity: true,
    requestToken: session.transport.getToken,
    persistToken: session.acceptToken,
    authenticated: async () => {
      if (!await session.refresh()) return;
      const current = session.capture();
      const owner = createOperationOwner({ owner: Object.freeze({}), dispatch: value => value,
        channels: { accepted: {
          prepare() { const target = adapters.redirect?.() || { name: "home" }; if (!current()) owner.revoke(); return { value: target }; },
          deliver(target) { return adapters.authenticated ? adapters.authenticated() : adapters.navigate(target); },
        } } });
      const operation = owner.operation();
      try { await owner.dispatch(operation, null); if (current()) owner.deliver(operation, "accepted", null); }
      finally { (await owner.dispose()).throwIfFailed(); }
    },
    beforeSignIn: session.beforeSignIn, capture: session.capture,
  });
}

export function loginError(error) {
  return error.response?.status === 401
    ? getToastOptions("Please check your credentials and try again.", "Login Failed", "error")
    : null;
}

/** Form inputs stay in the view; token ownership and login decisions live here. */
export function createLoginFlow({
  credentials, clearCredentials, redirect, navigate, toast,
  requestToken = getToken, persistToken = storeToken, reportError = apiErrorHandler,
  authenticated, isCurrent = () => true, identity = false,
  beforeSignIn, capture = () => isCurrent,
} = {}) {
  let pending = null, active = null, current = isCurrent, tokenAccepted = false, completing;
  let owner;
  const guarded = (prepare, deliver) => ({ prepare(value) {
    const prepared = prepare(value);
    if (!isCurrent() || !current()) owner.revoke();
    return { value: prepared };
  }, deliver });
  owner = createOperationOwner({ owner: Object.freeze({}),
    prepare(value) {
      const fields = { ...value };
      if (!isCurrent() || !current()) owner.revoke();
      return { value: fields };
    },
    async dispatch(fields) {
      if (beforeSignIn && !await beforeSignIn()) return null;
      if (!isCurrent() || !current()) return null;
      return requestToken(fields.username, fields.password, fields.totp);
    },
    channels: {
      token: guarded(token => ({ token, remember: credentials().rememberMe }), ({ token, remember }) => {
        if (persistToken(token, remember) === false) return;
        tokenAccepted = true;
        // The accepted token is this workflow's deliberate handoff. The next
        // phase captures it, never an arbitrary token selected at later dispatch.
        current = capture();
      }),
      complete: guarded(() => authenticated ? null : redirect() || { name: "home" }, target => { completing = authenticated ? authenticated() : navigate(target); }),
      clear: guarded(value => value, () => clearCredentials()),
      error: guarded(error => error, error => { const message = loginError(error); if (message) toast.add(message); else reportError(error, toast); }),
    },
  });
  function init(authType) {
    if (!identity && authType === authTypes.none) {
      if (authenticated) authenticated(); else navigate({ name: "home" });
    }
  }

  function logIn() {
    if (active || !isCurrent()) return pending;
    current = capture(); tokenAccepted = false;
    const operation = owner.operation(); active = operation;
    pending = owner.dispatch(operation, credentials())
      .then(result => {
        if (result.value === null || !owner.deliver(operation, "token", result.value) || !tokenAccepted) return;
        if (owner.deliver(operation, "complete", null)) return completing;
      })
      .catch((error) => {
        if (!isCurrent() || !current()) return;
        owner.deliver(operation, "clear", null);
        owner.deliver(operation, "error", error);
      }).finally(async () => { await owner.release(operation); active = null; pending = null; });
    return pending;
  }

  return { init, logIn, hasWork: owner.hasWork, settle: owner.settle, dispose: owner.dispose };
}
