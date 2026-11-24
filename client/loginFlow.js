// SPDX-License-Identifier: LGPL-3.0-only
import { apiErrorHandler } from "./api.js";
import { getToastOptions } from "./helpers.js";
import { createOperationOwner } from "./operationOwner.js";
import { bindContext } from "./sessionContext.js";
import { reactive, readonly } from "vue";

export function createIdentityLoginFlow({ session, recovery, ...adapters }) {
  let disposed = false, acceptedToken, acceptedPersist;
  const isCurrent = () => !disposed && (adapters.isCurrent?.() ?? true) && (!recovery || recovery.isCurrent());
  const flow = createLoginFlow({ ...adapters, isCurrent,
    requestToken: session.transport.getToken,
    persistToken(token, persist) {
      if (session.acceptToken(token, persist) === false) return false;
      acceptedToken = token; acceptedPersist = persist; return true;
    },
    authenticated: async (proof, acceptContext) => {
      if (!isCurrent()) return;
      const accepted = await session.signIn(acceptedToken, { login: proof.username, persist: acceptedPersist });
      if (!accepted || !isCurrent()) return;
      const current = acceptContext(accepted.current);
      if (!current()) return;
      const required = accepted.principal.passwordChangeRequired === true;
      const accountLanding = required || !recovery && !session.snapshot().capabilities.canRead;
      const target = accountLanding ? { name: "account" } : adapters.redirect?.() || { name: "home" };
      if (!current()) return;
      if (required) { session.retainLoginProof(proof, accepted); if (current()) await adapters.navigate(target); }
      else if (accountLanding) { await adapters.authenticated?.(); if (current()) await adapters.navigate(target); }
      else await (adapters.authenticated ? adapters.authenticated() : adapters.navigate(target));
    },
    // A retained operation is already owned by recovery. Making it settle for
    // departure here would require the very credential this form is obtaining.
    beforeSignIn: recovery ? recovery.isCurrent : session.beforeSignIn, capture: session.capture,
  });
  return { ...flow, dispose() { disposed = true; return flow.dispose(); } };
}

/** One transient password/code form for the page and public-note dialog. */
export function createIdentityLoginState({ session, recovery, navigate, redirect = () => null, authenticated, isCurrent = () => true, toast, reportError } = {}) {
  const fields = reactive({ username: "", password: "", totp: "", rememberMe: false, step: "password", busy: false });
  let disposed = false;
  const erase = () => { fields.password = ""; fields.totp = ""; };
  const flow = createIdentityLoginFlow({ session, recovery, navigate, redirect, authenticated, toast, reportError,
    credentials: () => fields, isCurrent: () => !disposed && isCurrent(),
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
function createLoginFlow({
  credentials, clearCredentials, toast,
  requestToken, persistToken, reportError = apiErrorHandler,
  authenticated, isCurrent, beforeSignIn, capture, challenge, clearAccepted = clearCredentials,
} = {}) {
  let pending = null, active = null, current, tokenAccepted = false, completing, acceptedProof, challenged = false, disposed = false;
  const acceptContext = session => current = bindContext(() => !disposed && isCurrent() && session());
  const channel = (prepare, deliver) => ({ prepare: value => ({ value: prepare(value) }), deliver });
  const owner = createOperationOwner({ owner: Object.freeze({}),
    prepare(value) {
      const fields = { ...value };
      acceptedProof = { username: fields.username, password: fields.password };
      return { value: fields };
    },
    async dispatch(fields) {
      if (!await beforeSignIn()) return null;
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
      complete: channel(() => acceptedProof, proof => { completing = authenticated(proof, acceptContext); }),
      clear: { deliver: () => clearCredentials() },
      accepted: { deliver: () => clearAccepted() },
      challenge: { deliver: error => { challenged = challenge?.(error) === true; } },
      error: { deliver: error => { const message = loginError(error); if (message) toast.add(message); else reportError(error, toast); } },
    },
  });
  function logIn() {
    if (active || disposed || !isCurrent()) return pending;
    acceptContext(capture()); tokenAccepted = false;
    const operation = owner.operation("live", current); active = operation;
    pending = owner.dispatch(operation, credentials())
      .then(result => {
        if (result.value === null || !owner.deliver(operation, "token", result.value) || !tokenAccepted) return;
        if (owner.deliver(operation, "complete", null, current)) {
          owner.deliver(operation, "accepted", null, current);
          return completing;
        }
      })
      .catch((error) => {
        challenged = false;
        owner.deliver(operation, "challenge", error, current);
        if (challenged) return;
        if (!tokenAccepted) owner.deliver(operation, "clear", null, current);
        owner.deliver(operation, "error", error, current);
      }).finally(async () => { acceptedProof = null; await owner.release(operation); active = null; pending = null; });
    return pending;
  }

  return { logIn, hasWork: () => pending !== null || owner.hasWork(),
    async settle() { if (pending) await pending; return owner.settle(); },
    dispose() { disposed = true; return owner.dispose(); } };
}
