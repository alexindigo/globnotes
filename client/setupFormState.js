// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly } from "vue";
import { getSetupStatus, postIdentitySetup, postIdentitySetupEnrolment } from "./api.js";
import { createUuid } from "../shared/uuid.ts";
import { createAuthenticatorEnrollment } from "./authenticatorEnrollment.js";
import { createOperationOwner } from "./operationOwner.js";

export const identitySetupLevels = [
  { level: "edit", label: "Edit", help: "Read, write and delete notes." },
  { level: "view", label: "View", help: "Read notes without changing them." },
  { level: "none", label: "No access", help: "Only people you add can open notes." },
];

/** Prepared public setup form; account/ACL publication stays on the server. */
export function createIdentitySetupFormState({ submit = postIdentitySetup, readStatus = getSetupStatus,
  enrol = postIdentitySetupEnrolment, completed = () => {}, signIn = () => {},
  beforeCommit = async () => true, copy, sessionKey,
} = {}) {
  const identity = Object.freeze({});
  const scopeKey = sessionKey ?? (() => identity), scope = scopeKey();
  const fields = reactive({ username: "", password: "", everybody: "view", totpEnabled: false, totpCode: "", busy: false, error: "" });
  let disposed = false, pending = null, completing;
  const current = () => !disposed && scope != null && scope === scopeKey();
  fields.editable = computed(() => !fields.busy && current());
  const enrollment = createAuthenticatorEnrollment({ enrol, copy, owner: identity, capture: () => {
    const name = fields.username; return () => current() && fields.totpEnabled && fields.username === name;
  } });
  fields.enrollment = enrollment.state;
  const owner = createOperationOwner({ owner: identity,
    cancel: () => enrollment.dispose(),
    prepare(intent) {
      const value = { ...intent, ...(intent.payload ? { payload: { ...intent.payload, ...(intent.payload.totp ? { totp: { ...intent.payload.totp } } : {}) } } : {}) };
      if (!current()) owner.revoke();
      return { value };
    }, async dispatch(intent) {
      if (intent.kind === "status") return readStatus();
      if (await beforeCommit() !== true || !current()) return null;
      return submit(intent.payload);
    },
    channels: { completed: { prepare(result) { const value = { ...result }; if (!current()) owner.revoke(); return { value }; },
      deliver(result) { erase(); completing = completed(result); } },
    signIn: { prepare(message) { if (!current()) owner.revoke(); return { value: message }; },
      deliver(message) { erase(); completing = signIn(message); } } },
  });
  function setField(name, value) {
    if (!current() || fields.busy || !["username", "password", "everybody", "totpCode"].includes(name)) return;
    if (name === "everybody" && !["edit", "view", "none"].includes(value)) return;
    fields[name] = value;
    if (name === "username" && fields.totpEnabled) { fields.totpCode = ""; return enrollment.start(value); }
  }
  async function toggleAuthenticator() {
    if (!current() || fields.busy) return false;
    fields.totpEnabled = !fields.totpEnabled; fields.totpCode = "";
    if (fields.totpEnabled) return await enrollment.start(fields.username);
    enrollment.clear(); return true;
  }
  function erase() { fields.password = ""; fields.totpCode = ""; enrollment.clear(); }
  function finish() {
    if (pending || fields.busy || !current()) return pending;
    fields.error = "";
    if (!fields.username.trim() || !fields.password) { fields.error = "Enter a login name and password."; return Promise.resolve(false); }
    if (fields.totpEnabled && (!enrollment.state.candidate || !/^\d{6}$/.test(fields.totpCode))) {
      fields.error = "Confirm the new authenticator with its six-digit code."; return Promise.resolve(false);
    }
    const payload = { username: fields.username, password: fields.password, everybody: fields.everybody, updateId: createUuid(),
      ...(fields.totpEnabled ? { totp: { key: enrollment.state.candidate.key, code: fields.totpCode } } : {}) };
    fields.busy = true;
    const operation = owner.operation();
    pending = (async () => {
      try {
        const result = (await owner.dispatch(operation, { kind: "submit", payload })).value;
        if (result === null || !current()) return false;
        if (!result?.access_token) throw Error("Missing setup acknowledgment.");
        if (!owner.deliver(operation, "completed", result)) return false;
        await completing; return true;
      } catch (error) {
        if (!current()) return false;
        if ([400, 401, 403, 409, 422, 429].includes(error.response?.status ?? error.status)) {
          fields.error = "Setup could not finish. Check your details and try again.";
        } else {
          const statusOperation = owner.operation();
          try {
            const status = (await owner.dispatch(statusOperation, { kind: "status" })).value;
            if (!current()) return false;
            if (status.setupRequired === false) {
              owner.deliver(operation, "signIn", "Setup finished. Sign in to continue."); await completing;
            } else if (status.setupRequired === true) fields.error = "Connection lost. Please try again.";
            else throw Error("Missing setup status.");
          } catch { if (current()) fields.error = "Setup is unavailable. Ask the server operator to check its accounts."; }
          finally { await owner.release(statusOperation); }
        }
        return false;
      } finally { fields.busy = false; pending = null; await owner.release(operation); }
    })();
    return pending;
  }
  return { state: readonly(fields), setField, toggleAuthenticator, finish, copyKey: enrollment.copyKey,
    hasWork: () => !!pending || owner.hasWork(), async settle() { if (pending) await pending; await enrollment.settle(); return true; },
    dispose() { disposed = true; erase(); return owner.dispose(); } };
}
