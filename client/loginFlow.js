// SPDX-License-Identifier: LGPL-3.0-only
import { apiErrorHandler, getToken } from "./api.js";
import { authTypes } from "./constants.js";
import { getToastOptions } from "./helpers.js";
import { storeToken } from "./tokenStorage.js";
import { createOperationOwner } from "./operationOwner.js";
import { bindContext } from "./sessionContext.js";
import { reactive, readonly } from "vue";

export function createIdentityLoginFlow({ session, ...adapters }) {
  let acceptedToken, acceptedPersist;
  return createLoginFlow({ ...adapters, identity: true,
    requestToken: session.transport.getToken,
    persistToken(token, persist) {
      if (session.acceptToken(token, persist) === false) return false;
      acceptedToken = token; acceptedPersist = persist; return true;
    },
    acceptIdentity: async (proof, acceptContext) => {
      const accepted = session.signIn ? await session.signIn(acceptedToken, { login: proof.username, persist: acceptedPersist }) :
        await session.acceptProjection();
      if (!accepted) return;
      const current = acceptContext(accepted.current);
      if (!current()) return;
      const required = accepted.principal.passwordChangeRequired === true;
      const target = required ? { name: "account" } : adapters.redirect?.() || { name: "home" };
      if (!current()) return;
      if (required) { session.retainLoginProof(proof, accepted); if (current()) await adapters.navigate(target); }
      else await (adapters.authenticated ? adapters.authenticated() : adapters.navigate(target));
    },
    beforeSignIn: session.beforeSignIn, capture: session.capture,
  });
}

/** One transient password/code form for the page and public-note dialog. */
export function createIdentityLoginState({ session, navigate, redirect = () => null, authenticated, toast, reportError } = {}) {
  const fields = reactive({ username: "", password: "", totp: "", rememberMe: false, step: "password", busy: false });
  let disposed = false;
  const erase = () => { fields.password = ""; fields.totp = ""; };
  const flow = createIdentityLoginFlow({ session, navigate, redirect, authenticated, toast, reportError,
    credentials: () => fields, isCurrent: () => !disposed,
    clearAccepted: erase,
    clearCredentials() { if (fields.step === "authenticator") fields.totp = ""; else erase(); },
    challenge(error) {
      if ((error.response?.data?.code ?? error.code) !== "authenticator_required") return false;
      fields.step = "authenticator"; fields.totp = ""; return true;
    },
  });
  return { state: readonly(fields), setField(name, value) {
    if (!disposed && !fields.busy && ["username", "password", "totp", "rememberMe"].includes(name)) fields[name] = value;
  }, async submit() {
    if (disposed || fields.busy) return;
    fields.busy = true;
    try { await flow.logIn(); } finally { if (!disposed) fields.busy = false; }
  }, useAnotherAccount() { if (!disposed && !fields.busy) { erase(); fields.username = ""; fields.step = "password"; } },
    hasWork: flow.hasWork, settle: flow.settle,
    dispose() { disposed = true; erase(); return flow.dispose(); } };
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
  authenticated, acceptIdentity, isCurrent = () => true, identity = false,
  beforeSignIn, capture = () => isCurrent, challenge, clearAccepted = clearCredentials,
} = {}) {
  let pending = null, active = null, current, tokenAccepted = false, completing, disposed = false, acceptedProof, challenged;
  const acceptContext = session => current = bindContext(() => !disposed && isCurrent() && session());
  const channel = (prepare, deliver) => ({ prepare: value => ({ value: prepare(value) }), deliver });
  const owner = createOperationOwner({ owner: Object.freeze({}),
    prepare(value) {
      const fields = { ...value };
      acceptedProof = { username: fields.username, password: fields.password };
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
      complete: channel(() => authenticated || acceptIdentity ? acceptedProof : redirect() || { name: "home" }, target => {
        completing = acceptIdentity ? acceptIdentity(target, acceptContext) : authenticated ? authenticated(target) : navigate(target);
      }),
      clear: { deliver: () => clearCredentials() },
      accepted: { deliver: () => clearAccepted() },
      challenge: { deliver: error => { challenged = challenge?.(error) === true; } },
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
        if (owner.deliver(operation, "complete", null, current)) {
          if (identity) owner.deliver(operation, "accepted", null, current);
          return completing;
        }
      })
      .catch((error) => {
        challenged = false;
        owner.deliver(operation, "challenge", error, current);
        if (challenged) return;
        if (!identity || !tokenAccepted) owner.deliver(operation, "clear", null, current);
        owner.deliver(operation, "error", error, current);
      }).finally(async () => { acceptedProof = null; await owner.release(operation); active = null; pending = null; });
    return pending;
  }

  return { init, logIn, hasWork: () => pending !== null || owner.hasWork(),
    async settle() { if (pending) await pending; return owner.settle(); },
    dispose() { disposed = true; return owner.dispose(); } };
}
