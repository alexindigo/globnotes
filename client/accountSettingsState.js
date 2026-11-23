// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly } from "vue";
import { getOwnAccount, patchOwnAccount, postAccountTotpEnrolment } from "./api.js";
import { getStoredToken, clearStoredToken } from "./tokenStorage.js";
import { resolveParticipants, retainUnsavedWork } from "./sessionActions.js";
import { createUuid } from "../shared/uuid.ts";
import { createAuthenticatorEnrollment } from "./authenticatorEnrollment.js";
import { createOperationOwner } from "./operationOwner.js";

/** Instance-scoped form. Live reads and retained credential acknowledgments have
 * different lifetimes; neither may select a replacement account's credentials. */
export function createAccountSettingsState({ read = getOwnAccount, write = patchOwnAccount,
  enrol = postAccountTotpEnrolment, token = getStoredToken, sessionKey = token,
  resolve = resolveParticipants, clearToken = clearStoredToken, signedOut = () => {},
  logout = async () => false, retire = retainUnsavedWork, copy, consumeProof,
} = {}) {
  const fields = reactive({ view: null, loading: false, busy: false, error: "", dialog: null, confirmation: null,
    currentPassword: "", currentTotp: "", newPassword: "", confirmPassword: "", newTotpCode: "" });
  const form = Object.freeze({ scope: sessionKey(), token: token() });
  let ownsTemporaryProof = false;
  let disposed = false, revoked = false, ticket = 0, pending = null, proposed = null, resolving = false, signingOut;
  const current = () => !disposed && !revoked && form.scope != null && form.token != null && form.scope === sessionKey() && form.token === token();
  const enrollment = createAuthenticatorEnrollment({ enrol: () => enrol({ token: form.token }), copy, capture: () => current,
    owner: form });
  fields.enrollment = enrollment.state;
  fields.methodLabel = computed(() => fields.view?.totpEnabled ? "Password + authenticator" : "Password");
  fields.dialogTitle = computed(() => ({ enable: "Add authenticator", replace: "Replace authenticator", remove: "Remove authenticator" })[fields.dialog] ?? "Confirm your authenticator");
  const owner = createOperationOwner({ owner: form,
    cancel: () => enrollment.dispose(),
    prepare(intent) {
      const prepared = { ...intent, ...(intent.payload ? { payload: { ...intent.payload, ...(intent.payload.totp ? { totp: { ...intent.payload.totp } } : {}) } } : {}) };
      if (!current() || prepared.token !== form.token) owner.revoke();
      return { value: prepared };
    },
    dispatch(intent) {
      if (!current() || intent.token !== token()) throw Error("Account form is no longer current.");
      if (intent.kind === "read") return read({ token: form.token });
      if (intent.kind === "resolve") return resolve("changing your credentials");
      return write(intent.payload, { token: form.token });
    },
    channels: { view: { prepare(value) {
      const prepared = { ...value, view: { ...value.view } };
      if (!current() || prepared.ticket !== ticket) void owner.release(prepared.operation);
      return { value: prepared };
    }, deliver(value) { fields.view = value.view; } } },
    completion: { prepare(value) {
      const prepared = { ...value };
      if (disposed || form.token !== token()) void owner.release(prepared.operation);
      return { value: prepared };
    }, deliver(value) { signingOut = handoff(value.uncertain); } },
  });
  function erase() {
    ownsTemporaryProof = false;
    for (const key of ["currentPassword", "currentTotp", "newPassword", "confirmPassword", "newTotpCode"]) fields[key] = "";
    enrollment.clear(); proposed = null; fields.dialog = null; fields.confirmation = null;
  }
  function setField(name, value) {
    if (!current() || resolving || fields.busy || fields.confirmation) return;
    if (["currentPassword", "currentTotp", "newPassword", "confirmPassword", "newTotpCode"].includes(name)) fields[name] = value;
  }
  async function load() {
    if (!current()) return null;
    const operation = owner.operation(), own = ++ticket;
    fields.loading = true; fields.error = "";
    try {
      const result = await owner.dispatch(operation, { kind: "read", token: form.token });
      if (!owner.deliver(operation, "view", { operation, ticket: own, view: result.value })) return null;
      if (fields.view.passwordChangeRequired && !ownsTemporaryProof && consumeProof && !acceptTemporaryProof(consumeProof())) {
        if (current()) { erase(); retire(); if (form.token === token()) { clearToken(); await signedOut({ message: "Sign in again to choose your password.", uncertain: false }); } }
        return null;
      }
      return fields.view;
    } catch { if (current() && own === ticket) fields.error = "Could not read your account. Please try again."; return null; }
    finally { if (own === ticket) fields.loading = false; await owner.release(operation); }
  }
  function proof() {
    if (!fields.currentPassword || fields.view?.totpEnabled && !/^\d{6}$/.test(fields.currentTotp)) {
      fields.error = "Enter your current password and authenticator code, if used."; return false;
    }
    return true;
  }
  function password() {
    if (!fields.newPassword || fields.newPassword !== fields.confirmPassword) {
      fields.error = "Enter the same new password in both fields."; return false;
    }
    return true;
  }
  function payload(kind) {
    return { revision: fields.view.credentialRevision, updateId: createUuid(), currentPassword: fields.currentPassword,
      ...(fields.view.totpEnabled ? { currentTotp: fields.currentTotp } : {}),
      ...(kind === "password" ? { newPassword: fields.newPassword } : { totp: kind === "remove" ? { enabled: false } :
        { enabled: true, key: enrollment.state.candidate.key, code: fields.newTotpCode } }) };
  }
  async function beginAuthenticator(kind) {
    if (!current() || resolving || fields.busy || fields.confirmation || !fields.view || !["enable", "replace", "remove"].includes(kind)) return false;
    fields.dialog = kind; fields.error = ""; fields.currentTotp = ""; fields.newTotpCode = "";
    if (kind !== "remove") return await enrollment.start();
    enrollment.clear(); return true;
  }
  async function requestChange(kind = "password") {
    if (!current() || resolving || fields.busy || fields.confirmation || !fields.view || !["password", "enable", "replace", "remove"].includes(kind)) return false;
    fields.error = "";
    if (!proof() || kind === "password" && !password()) return false;
    if (["enable", "replace"].includes(kind) && (!enrollment.state.candidate || !/^\d{6}$/.test(fields.newTotpCode))) {
      fields.error = "Confirm the new authenticator with its six-digit code."; return false;
    }
    const request = Object.freeze({ kind, payload: payload(kind), token: form.token, dialog: fields.dialog });
    const operation = owner.operation(); resolving = true;
    try {
      const decision = (await owner.dispatch(operation, { kind: "resolve", token: form.token })).value;
      if (decision !== "proceed" || !current()) return false;
      proposed = request; fields.dialog = null;
      const name = kind === "password" ? "password" : "authenticator";
      const usesCode = kind === "enable" || kind === "replace" || kind === "password" && fields.view.totpEnabled;
      fields.confirmation = { title: `Change ${name} and log out?`,
        message: `This will change your ${name} and log you out here and on your other devices. Sign in again with your ${kind === "password" ? "new password" : "password"}${usesCode ? " and your authenticator." : "."}`,
        confirmLabel: "Change and log out" };
      return true;
    } finally { resolving = false; await owner.release(operation); }
  }
  function cancelConfirmation() {
    if (fields.busy) return false;
    fields.dialog = proposed?.dialog ?? null; fields.confirmation = null; proposed = null; return true;
  }
  async function handoff(uncertain) {
    erase(); retire();
    if (disposed || form.token !== token()) return;
    clearToken();
    await signedOut({ uncertain, message: uncertain ? "Connection lost. Sign in again." : "Sign in again with your new credentials." });
  }
  function commit(request) {
    if (pending) return pending;
    if (fields.busy || !current() || request.token !== token()) return Promise.resolve(false);
    const operation = owner.operation("retained"); fields.busy = true; fields.error = "";
    pending = (async () => {
      try {
        const result = (await owner.dispatch(operation, request)).value;
        if (result?.requiresLogin !== true || result.updateId !== request.payload.updateId) throw Error("Missing credential acknowledgment.");
        if (!owner.complete(operation, { operation, uncertain: false })) return false;
        await signingOut; return true;
      } catch (error) {
        const status = error.response?.status ?? error.status;
        if ([400, 401, 403, 409, 422, 429].includes(status)) {
          if (current()) {
            fields.confirmation = null; fields.dialog = request.dialog; proposed = null;
            fields.error = "Your credentials could not be changed. Check your details and try again.";
            if (status === 409) await load();
          }
        } else if (owner.complete(operation, { operation, uncertain: true })) await signingOut;
        return false;
      } finally { fields.busy = false; pending = null; await owner.release(operation); }
    })();
    return pending;
  }
  function acceptTemporaryProof(value) {
    if (!current() || !fields.view?.passwordChangeRequired || !value || typeof value.username !== "string" || value.username.trim().toLowerCase() !== fields.view.login || typeof value.password !== "string" || !value.password) return false;
    ownsTemporaryProof = true;
    fields.currentPassword = value.password; fields.currentTotp = ""; return true;
  }
  async function completeRequired() {
    if (!current() || !fields.view?.passwordChangeRequired || fields.busy || !password() || !fields.currentPassword) return false;
    if (fields.view.totpEnabled && !/^\d{6}$/.test(fields.currentTotp)) { fields.dialog = "required-proof"; return false; }
    return await commit({ kind: "password", payload: payload("password"), token: form.token, dialog: "required-proof" });
  }
  return { state: readonly(fields), setField, load, beginAuthenticator, requestChange, completeRequired, acceptTemporaryProof,
    confirmChange: () => proposed ? commit(proposed) : Promise.resolve(false), cancelConfirmation,
    cancelDialog() { if (!fields.busy) { fields.dialog = null; fields.currentTotp = ""; fields.newTotpCode = ""; enrollment.clear(); } },
    copyKey: enrollment.copyKey, logout: () => current() ? logout() : false,
    hasWork: () => resolving || !!pending || owner.hasWork() || !!fields.newPassword || !!enrollment.state.candidate,
    async settle() { if (pending) await pending; await owner.settle(); await enrollment.settle(); return true; },
    revoke() { revoked = true; owner.revoke(); enrollment.clear(); },
    dispose() { disposed = true; ticket++; erase(); return owner.dispose(); },
  };
}
