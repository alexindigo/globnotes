// SPDX-License-Identifier: LGPL-3.0-only
import { apiErrorHandler, getToken } from "./api.js";
import { authTypes } from "./constants.js";
import { getToastOptions } from "./helpers.js";
import { storeToken } from "./tokenStorage.js";
import { createOperationOwner } from "./operationOwner.js";
import { bindContext } from "./sessionContext.js";

export function createIdentityLoginFlow({ session, ...adapters }) {
  return createLoginFlow({ ...adapters, identity: true,
    requestToken: session.transport.getToken,
    persistToken: session.acceptToken,
    authenticated: async acceptContext => {
      let current;
      if (!await session.refresh(accepted => { current = acceptContext(accepted); }) || !current?.()) return;
      const target = adapters.redirect?.() || { name: "home" };
      if (current()) await (adapters.authenticated ? adapters.authenticated() : adapters.navigate(target));
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
  let pending = null, active = null, current, tokenAccepted = false, completing, disposed = false;
  const acceptContext = session => current = bindContext(() => !disposed && isCurrent() && session());
  const channel = (prepare, deliver) => ({ prepare: value => ({ value: prepare(value) }), deliver });
  const owner = createOperationOwner({ owner: Object.freeze({}),
    prepare(value) {
      const fields = { ...value };
      return { value: fields };
    },
    async dispatch(fields) {
      if (beforeSignIn && !await beforeSignIn()) return null;
      if (!current()) return null;
      return requestToken(fields.username, fields.password, fields.totp);
    },
    channels: {
      token: channel(token => ({ token, remember: credentials().rememberMe }), ({ token, remember }) => {
        if (persistToken(token, remember) === false) return;
        tokenAccepted = true;
        // The accepted token is this workflow's deliberate handoff. The next
        // phase captures it, never an arbitrary token selected at later dispatch.
        acceptContext(capture());
      }),
      complete: channel(() => authenticated ? null : redirect() || { name: "home" }, target => { completing = authenticated ? authenticated(acceptContext) : navigate(target); }),
      clear: { deliver: () => clearCredentials() },
      error: { deliver: error => { const message = loginError(error); if (message) toast.add(message); else reportError(error, toast); } },
    },
  });
  function init(authType) {
    if (!identity && authType === authTypes.none) {
      if (authenticated) authenticated(); else navigate({ name: "home" });
    }
  }

  function logIn() {
    if (active || disposed || !isCurrent()) return pending;
    acceptContext(capture()); tokenAccepted = false;
    const operation = owner.operation("live", current); active = operation;
    pending = owner.dispatch(operation, credentials())
      .then(result => {
        if (result.value === null || !owner.deliver(operation, "token", result.value) || !tokenAccepted) return;
        if (owner.deliver(operation, "complete", null, current)) return completing;
      })
      .catch((error) => {
        owner.deliver(operation, "clear", null, current);
        owner.deliver(operation, "error", error, current);
      }).finally(async () => { await owner.release(operation); active = null; pending = null; });
    return pending;
  }

  return { init, logIn, hasWork: () => pending !== null || owner.hasWork(),
    async settle() { if (pending) await pending; return owner.settle(); },
    dispose() { disposed = true; return owner.dispose(); } };
}
