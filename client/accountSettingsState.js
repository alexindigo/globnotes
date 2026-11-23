// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly } from "vue";
import { getOwnAccount, patchOwnAccount, postAccountTotpEnrolment } from "./api.js";
import { getStoredToken, clearStoredToken } from "./tokenStorage.js";
import { resolveParticipants, retainUnsavedWork } from "./sessionActions.js";
import { createUuid } from "../shared/uuid.ts";
import { createAuthenticatorEnrollment } from "./authenticatorEnrollment.js";
import { createOperationOwner } from "./operationOwner.js";

const idle = Object.freeze({ kind: "idle" });
const temporaryProofMessage = "Sign in again to choose your password.";
const credentialFields = ["currentPassword", "currentTotp", "newPassword", "confirmPassword", "newTotpCode"];

/** Instance-scoped form. Live reads and retained credential acknowledgments have
 * different lifetimes; neither may select a replacement account's credentials. */
export function createAccountSettingsState({ read = getOwnAccount, write = patchOwnAccount,
  enrol = postAccountTotpEnrolment, token = getStoredToken, sessionKey = token,
  resolve = resolveParticipants, clearToken = clearStoredToken, signedOut = () => {},
  logout = async () => false, retire = retainUnsavedWork, copy, consumeProof, beginHandoff = () => () => {},
} = {}) {
  const fields = reactive({ view: null, activity: idle, dialog: null, confirmation: null,
    currentPassword: "", currentTotp: "", newPassword: "", confirmPassword: "", newTotpCode: "" });
  const form = Object.freeze({ scope: sessionKey(), token: token() });
  let ownsTemporaryProof = false;
  let disposed = false, revoked = false, ticket = 0, pending = null, proposed = null, signingOut;
  const current = () => !disposed && !revoked && form.scope != null && form.token != null && form.scope === sessionKey() && form.token === token();
  const enrollment = createAuthenticatorEnrollment({ enrol: () => enrol({ token: form.token }), copy, capture: () => current,
    owner: form });
  fields.enrollment = enrollment.state;
  fields.loading = computed(() => fields.activity.kind === "loading");
  fields.locked = computed(() => ["loading", "resolving", "busy"].includes(fields.activity.kind));
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
  function refusal(reason, message, ...names) {
    return { kind: "refused", reason, message, ...(names.length ? { invalid: Object.fromEntries(names.map(name => [name, true])) } : {}) };
  }
  function refuse(...details) { fields.activity = refusal(...details); return false; }
  function admit() {
    if (fields.locked) return false;
    if (current()) return true;
    return fields.activity.kind === "refused" ? false : refuse("not-current", "This account is no longer current. Sign in again.");
  }
  function authenticatorAction(kind) {
    return fields.view?.totpEnabled === true ? ["replace", "remove"].includes(kind) :
      fields.view?.totpEnabled === false && kind === "enable";
  }
  const requiredProofDialog = () => fields.view?.totpEnabled ? "required-proof" : null;

  function erase() {
    ownsTemporaryProof = false;
    for (const key of credentialFields) fields[key] = "";
    enrollment.clear(); proposed = null; fields.dialog = null; fields.confirmation = null;
  }
  function setField(name, value) {
    if (!admit() || fields.confirmation || !credentialFields.includes(name) || name === "currentPassword" && fields.view?.passwordChangeRequired) return false;
    fields[name] = value;
    if (fields.activity.invalid?.[name]) fields.activity = idle;
    return true;
  }
  async function readAccount(operation, own) {
    const result = await owner.dispatch(operation, { kind: "read", token: form.token });
    return owner.deliver(operation, "view", { operation, ticket: own, view: result.value });
  }
  async function load() {
    if (!fields.loading && !admit()) return null;
    if (!current() || fields.confirmation) return null;
    const operation = owner.operation(), own = ++ticket;
    fields.activity = { kind: "loading", message: "Loading your account..." };
    let final = idle;
    try {
      if (!await readAccount(operation, own) || !current() || own !== ticket) return null;
      if (fields.view.passwordChangeRequired && !ownsTemporaryProof) {
        const value = consumeProof?.();
        if (!current() || own !== ticket) return null;
        if (!adoptTemporaryProof(value)) {
          final = refusal("temporary-proof", temporaryProofMessage);
          // An installed proof source can detect a restricted session restored without its one-use proof.
          if (consumeProof) {
            erase(); retire();
            if (form.token === token()) { clearToken(); await signedOut({ message: temporaryProofMessage, uncertain: false }); }
            return null;
          }
        }
      }
      return fields.view;
    } catch { if (current() && own === ticket) final = refusal("read-failed", "Could not read your account. Please try again."); return null; }
    finally { await owner.release(operation); if (own === ticket) fields.activity = final; }
  }
  function proof() {
    const invalid = [];
    if (!fields.currentPassword) invalid.push("currentPassword");
    if (fields.view.totpEnabled && !/^\d{6}$/.test(fields.currentTotp)) invalid.push("currentTotp");
    return !invalid.length || refuse("current-credentials", "Enter your current password and authenticator code, if used.", ...invalid);
  }
  function password() {
    return !!fields.newPassword && fields.newPassword === fields.confirmPassword ||
      refuse("password-mismatch", "Enter the same new password in both fields.", "newPassword", "confirmPassword");
  }
  function payload(kind) {
    return { revision: fields.view.credentialRevision, updateId: createUuid(), currentPassword: fields.currentPassword,
      ...(fields.view.totpEnabled ? { currentTotp: fields.currentTotp } : {}),
      ...(kind === "password" ? { newPassword: fields.newPassword } : { totp: kind === "remove" ? { enabled: false } :
        { enabled: true, key: enrollment.state.candidate.key, code: fields.newTotpCode } }) };
  }
  async function beginAuthenticator(kind) {
    if (!admit() || fields.confirmation) return false;
    if (!authenticatorAction(kind)) return refuse("unavailable-action", "This authenticator change is not available for your account.");
    fields.dialog = kind; fields.activity = idle; fields.currentTotp = ""; fields.newTotpCode = "";
    if (kind !== "remove") return await enrollment.start();
    enrollment.clear(); return true;
  }
  async function requestChange(kind = "password") {
    if (!admit() || fields.confirmation) return false;
    if (!fields.view || kind !== "password" && (fields.dialog !== kind || !authenticatorAction(kind))) {
      return refuse("unavailable-action", "This change is not available for your account.");
    }
    if (!proof() || kind === "password" && !password()) return false;
    if (["enable", "replace"].includes(kind) && (!enrollment.state.candidate || !/^\d{6}$/.test(fields.newTotpCode))) {
      return refuse("new-authenticator", "Confirm the new authenticator with its six-digit code.", "newTotpCode");
    }
    const request = Object.freeze({ kind, payload: payload(kind), token: form.token, dialog: fields.dialog });
    const operation = owner.operation();
    fields.activity = { kind: "resolving", message: "Preparing to change your credentials..." };
    let final = idle;
    try {
      const decision = (await owner.dispatch(operation, { kind: "resolve", token: form.token })).value;
      if (!current()) return false;
      if (decision !== "proceed") { final = refusal("departure-cancelled", "Credential change cancelled."); return false; }
      proposed = request; fields.dialog = null;
      const name = kind === "password" ? "password" : "authenticator";
      const usesCode = kind === "enable" || kind === "replace" || kind === "password" && fields.view.totpEnabled;
      fields.confirmation = { title: `Change ${name} and log out?`,
        message: `This will change your ${name} and log you out here and on your other devices. Sign in again with your ${kind === "password" ? "new password" : "password"}${usesCode ? " and your authenticator." : "."}`,
        confirmLabel: "Change and log out" };
      return true;
    } catch {
      if (current()) final = refusal("resolve-failed", "Could not prepare to change your credentials. Please try again.");
      return false;
    } finally { await owner.release(operation); fields.activity = final; }
  }
  function cancelConfirmation() {
    if (!admit() || !fields.confirmation) return false;
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
    if (!admit() || request.token !== token()) return Promise.resolve(false);
    const operation = owner.operation("retained");
    fields.activity = { kind: "busy", message: request.required ? "Changing your password..." : "Changing your credentials..." };
    const finishHandoff = beginHandoff();
    pending = (async () => {
      let final = idle;
      try {
        const result = (await owner.dispatch(operation, request)).value;
        if (result?.requiresLogin !== true || result.updateId !== request.payload.updateId) throw Error("Missing credential acknowledgment.");
        if (!owner.complete(operation, { operation, uncertain: false })) return false;
        await signingOut; return true;
      } catch (error) {
        const status = error.response?.status ?? error.status;
        if ([400, 401, 403, 409, 422, 429].includes(status)) {
          if (current()) {
            if (status === 409) {
              const refresh = owner.operation(), own = ++ticket;
              try { await readAccount(refresh, own); }
              catch { /* Keep the definite write refusal even if refreshing fails. */ }
              finally { await owner.release(refresh); }
            }
            if (current()) {
              fields.confirmation = null; proposed = null;
              fields.dialog = request.required ? requiredProofDialog() : authenticatorAction(request.dialog) ? request.dialog : null;
              final = refusal("write-rejected", "Your credentials could not be changed. Check your details and try again.");
            }
          }
        } else if (owner.complete(operation, { operation, uncertain: true })) await signingOut;
        return false;
      } finally {
        try { await owner.release(operation); }
        finally { pending = null; fields.activity = final; finishHandoff(); }
      }
    })();
    return pending;
  }
  function adoptTemporaryProof(value) {
    if (!current() || !fields.view?.passwordChangeRequired || !value || typeof value.username !== "string" || value.username.trim().toLowerCase() !== fields.view.login || typeof value.password !== "string" || !value.password) return false;
    ownsTemporaryProof = true;
    fields.currentPassword = value.password; fields.currentTotp = ""; return true;
  }
  function acceptTemporaryProof(value) {
    if (!admit() || fields.confirmation) return false;
    if (!adoptTemporaryProof(value)) return refuse("temporary-proof", temporaryProofMessage);
    fields.activity = idle;
    return true;
  }
  async function completeRequired() {
    if (!admit() || fields.confirmation) return false;
    if (!fields.view?.passwordChangeRequired) return refuse("unavailable-action", "This account does not need a password change.");
    if (!ownsTemporaryProof) return refuse("temporary-proof", temporaryProofMessage);
    if (!password()) return false;
    const dialog = requiredProofDialog();
    if (dialog && !/^\d{6}$/.test(fields.currentTotp)) {
      if (fields.dialog === dialog) return refuse("current-code", "Enter a six-digit authenticator code.", "currentTotp");
      fields.dialog = dialog; fields.activity = idle; return false;
    }
    return await commit({ kind: "password", payload: payload("password"), token: form.token, required: true });
  }
  return { state: readonly(fields), setField, load, beginAuthenticator, requestChange, completeRequired, acceptTemporaryProof,
    confirmChange: () => proposed ? commit(proposed) : Promise.resolve(false), cancelConfirmation,
    cancelDialog() {
      if (!admit() || !fields.dialog) return false;
      fields.dialog = null; fields.currentTotp = ""; fields.newTotpCode = ""; enrollment.clear(); fields.activity = idle;
      return true;
    },
    copyKey: () => admit() && !fields.confirmation && enrollment.copyKey(),
    logout: () => admit() && !fields.confirmation && logout(),
    retainedWork: () => (fields.locked && !fields.loading) || !!fields.currentPassword || !!fields.currentTotp || !!fields.newPassword || !!fields.confirmPassword || !!fields.dialog || !!fields.confirmation || !!enrollment.state.candidate,
    hasWork: () => fields.locked || owner.hasWork() || !!fields.newPassword || !!enrollment.state.candidate,
    discard() { if (fields.locked) return false; erase(); fields.activity = idle; return true; },
    async settle() { if (pending) await pending; await owner.settle(); await enrollment.settle(); return true; },
    revoke() { revoked = true; owner.revoke(); enrollment.clear(); },
    dispose() { disposed = true; ticket++; erase(); return owner.dispose(); },
  };
}
