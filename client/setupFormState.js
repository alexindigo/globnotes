// SPDX-License-Identifier: LGPL-3.0-only
import { computed, nextTick, reactive, readonly, toRefs, watch } from "vue";
import { getAccessSettings, getConfig, postAccessTotpEnrolment, postSetup, postTotpEnrolment, putAccessSettings } from "./api.js";
import { createAccessSettingsState } from "./accessSettingsState.js";
import { copyText } from "./clipboard.js";

export const setupOptions = [
  { mode: "password", title: "Password protected", description: "A username and password are required to read or edit notes." },
  { mode: "read_only", title: "Read-only", description: "Anyone who can reach this server can read notes. Editing is disabled." },
  { mode: "none", title: "Open access", description: "Anyone who can reach this server can read, edit, and delete notes. No sign-in required." },
];

/** Owns first-run form policy and delegates configured writes/review to Access. */
export function createSetupFormState({
  dismissible = () => false, beforeCommit = async () => true, completed = () => {}, focus = () => {},
  readAccess = getAccessSettings, writeAccess = putAccessSettings, readStatus = getConfig,
  enrolAccess = postAccessTotpEnrolment, enrolSetup = postTotpEnrolment,
  submitSetup = postSetup, copy = copyText,
} = {}) {
  const access = createAccessSettingsState({ read: readAccess, write: writeAccess, readStatus, completed });
  const fields = reactive({
    mode: "password", username: "", usernameEdited: false, password: "", showPassword: false,
    acked: false, readOnlySettings: false, currentPassword: "", currentTotp: "", replacingTotp: false,
    submitting: false, feedback: "", missingUsername: false, missingPassword: false, missingAck: false,
    totpEnabled: false, totpKey: "", totpSecret: "", totpQr: "", totpCode: "", missingTotp: false,
    copyArmed: false, copying: false, copyFeedback: "",
  });
  const accessView = computed(() => access.state.view);
  const accessLoading = computed(() => dismissible() && (access.state.loading || !accessView.value));
  const existingAccount = computed(() => dismissible() && !!accessView.value?.username);
  const existingTotp = computed(() => existingAccount.value && accessView.value?.totpEnabled);
  const pending = computed(() => fields.submitting || access.state.pending || access.state.inFlight || access.state.reviewing);
  // Preserve each control's existing admission policy, including the narrower
  // QR/code/replacement guards. The view never recomputes pin combinations.
  const disabled = computed(() => {
    const busy = pending.value || accessLoading.value;
    const pinned = accessView.value?.pinned;
    const outsidePassword = fields.mode !== "password";
    return {
      mode: busy || pinned?.mode,
      username: busy || pinned?.username || outsidePassword,
      password: busy || pinned?.password || pinned?.sessions || outsidePassword,
      totp: busy || pinned?.totp || pinned?.sessions || outsidePassword,
      qr: pending.value || fields.copying || outsidePassword,
      code: pending.value || outsidePassword,
      replaceAuthenticator: pending.value || pinned?.totp || pinned?.sessions,
      readOnlySettings: busy || fields.mode !== "none" || pinned?.readOnlySettings,
      ack: pending.value || fields.mode !== "none",
      proof: pending.value,
      review: pending.value || access.state.reviewing,
      submit: busy || access.state.needsReview || (dismissible() && !accessView.value?.settingsWritable) || (fields.mode === "none" && !fields.acked),
    };
  });
  const state = readonly(reactive({
    ...toRefs(fields),
    accessView, accessLoading, existingAccount, existingTotp, pending, disabled,
    needsReview: computed(() => access.state.needsReview),
    submitLabel: computed(() => !dismissible() ? fields.submitting ? 'Setting up…' : 'Finish setup'
      : access.state.reviewing || accessLoading.value ? 'Checking current access…'
      : access.state.unknown ? 'Waiting for the server to confirm…'
      : access.state.pending || access.state.inFlight ? 'Saving access settings…' : 'Save access settings'),
    message: computed(() => fields.feedback || access.state.error),
    showEnrolment: computed(() => !!(fields.totpEnabled && (!existingTotp.value || fields.replacingTotp || fields.totpKey))),
    showReplacement: computed(() => !!(fields.totpEnabled && existingTotp.value && !fields.replacingTotp)),
  }));
  let enrolmentTicket = 0, copyTicket = 0, disposed = false;
  const editable = ["mode", "username", "password", "showPassword", "acked", "readOnlySettings", "currentPassword", "currentTotp", "totpEnabled", "totpCode"];

  function setField(name, value) {
    if (!editable.includes(name)) return;
    fields[name] = value;
    if (name === "username") fields.usernameEdited = true;
  }

  const stops = [watch(accessView, (view, previous) => {
    // Review refreshes an untouched username without changing credential intent.
    if (view && previous && !fields.usernameEdited) fields.username = view.username;
  })];

  function resetCopyConfirmation() {
    copyTicket++;
    fields.copyArmed = false;
    fields.copyFeedback = "";
  }

  function copyFocus(isQrControl) {
    // A disabled QR can lose focus without blur; the next owner retires it.
    if (!isQrControl) resetCopyConfirmation();
  }

  function copyBlur(hasNextTarget) {
    // Native busy-disabling blur is not a new focus attempt.
    if (fields.copying && !hasNextTarget) return;
    resetCopyConfirmation();
  }

  async function copyTotpKey() {
    if (pending.value || fields.copying || !fields.totpSecret) return;
    if (!fields.copyArmed) {
      fields.copyArmed = true;
      fields.copyFeedback = "Click again to copy the setup key.";
      return;
    }
    fields.copyArmed = false;
    fields.copying = true;
    const secret = fields.totpSecret, ticket = copyTicket;
    const current = () => !disposed && ticket === copyTicket && fields.totpSecret === secret && fields.mode === "password";
    try {
      await copy(secret);
      if (current()) fields.copyFeedback = "Setup key copied.";
    } catch {
      if (current()) fields.copyFeedback = "Could not copy the setup key. Please try again.";
    } finally { fields.copying = false; }
  }

  stops.push(watch(() => fields.totpEnabled, async enabled => {
    const ticket = ++enrolmentTicket;
    resetCopyConfirmation();
    fields.missingTotp = false;
    fields.totpCode = "";
    if (!enabled) {
      fields.totpKey = ""; fields.totpSecret = ""; fields.totpQr = "";
      return;
    }
    if (existingTotp.value && !fields.replacingTotp) return;
    try {
      const bundle = await (dismissible() ? enrolAccess : enrolSetup)(fields.username);
      if (disposed || ticket !== enrolmentTicket || !fields.totpEnabled) return;
      fields.totpKey = bundle.key; fields.totpSecret = bundle.secret; fields.totpQr = bundle.qr;
    } catch {
      if (disposed || ticket !== enrolmentTicket) return;
      fields.totpKey = ""; fields.totpSecret = ""; fields.totpQr = "";
      fields.feedback = "Could not start TOTP enrolment. Please try again.";
      fields.totpEnabled = false;
    }
  }));

  async function replaceAuthenticator() {
    if (pending.value) return;
    fields.replacingTotp = true;
    fields.totpEnabled = false;
    await nextTick();
    fields.totpEnabled = true;
  }

  async function load() {
    if (dismissible()) {
      const view = await access.load();
      if (view && !disposed) {
        fields.mode = view.mode; fields.username = view.username; fields.totpEnabled = view.totpEnabled;
        fields.readOnlySettings = view.mode === "none" ? view.readOnlySettings : true;
      }
    }
  }

  stops.push(watch(() => fields.mode, () => {
    resetCopyConfirmation();
    fields.acked = false; fields.showPassword = false; fields.feedback = "";
    fields.missingUsername = false; fields.missingPassword = false; fields.missingAck = false;
  }));

  function payload() {
    const proposed = fields.mode === "password"
      ? {
        mode: "password", username: fields.username,
        ...(!existingAccount.value || fields.password ? { password: fields.password } : {}),
        ...(fields.totpEnabled && fields.totpKey ? { totpKey: fields.totpKey, totpCode: fields.totpCode } : {}),
      }
      : { mode: fields.mode, ...(fields.mode === "none" ? { readOnlySettings: fields.readOnlySettings } : {}) };
    if (!dismissible()) return proposed;
    const configured = {
      ...proposed, ...(fields.mode === "password" ? { totpEnabled: fields.totpEnabled } : {}),
      ...(fields.mode === "none" ? { readOnlySettings: fields.readOnlySettings } : {}),
      ...(existingAccount.value ? { currentPassword: fields.currentPassword, ...(existingTotp.value ? { currentTotp: fields.currentTotp } : {}) } : {}),
    };
    if (fields.mode === "password" && existingAccount.value && !fields.usernameEdited) delete configured.username;
    if (existingTotp.value && !fields.replacingTotp && !fields.totpKey) { delete configured.totpKey; delete configured.totpCode; }
    return configured;
  }

  async function finish() {
    if (pending.value || accessLoading.value || access.state.needsReview) return;
    fields.feedback = ""; fields.missingUsername = false; fields.missingPassword = false; fields.missingAck = false;
    if (fields.mode === "password") {
      fields.missingUsername = !fields.username;
      fields.missingPassword = !existingAccount.value && !fields.password;
      fields.missingTotp = fields.totpEnabled && (!existingTotp.value || fields.replacingTotp || !!fields.totpKey) && !/^\d{6}$/.test(fields.totpCode);
      if (fields.missingUsername || fields.missingPassword || fields.missingTotp) {
        fields.feedback = fields.missingTotp ? "Enter the current 6-digit code from your authenticator." : "Enter a username and password.";
        nextTick(() => focus(fields.missingUsername ? "username" : fields.missingPassword ? "password" : "totpCode"));
        return;
      }
    } else if (fields.mode === "none" && !fields.acked) {
      fields.missingAck = true; fields.feedback = "Confirm that you understand open access.";
      nextTick(() => focus("ack"));
      return;
    }
    if (existingAccount.value && (!fields.currentPassword || (existingTotp.value && !/^\d{6}$/.test(fields.currentTotp)))) {
      fields.feedback = "Confirm your current password and current authenticator code.";
      return;
    }
    const proposed = payload();
    if (dismissible()) {
      await access.commit(proposed, beforeCommit);
      return;
    }
    fields.submitting = true;
    try {
      if (await beforeCommit() !== true || disposed) { fields.submitting = false; return; }
    } catch {
      fields.feedback = "Your changes could not be resolved. Keep editing and try again.";
      fields.submitting = false;
      return;
    }
    submitSetup(proposed).then(() => {
      // Busy state is retained through the parent-owned handoff.
      completed();
    }).catch(error => {
      const detail = error.response?.data?.detail;
      fields.feedback = error.message === "env-pinned"
        ? "Access mode is pinned by environment configuration."
        : error.response?.status === 400 && detail ? detail : "Setup failed. Please try again.";
      if (error.response?.status === 400 && fields.totpEnabled) {
        fields.totpCode = "";
        nextTick(() => focus("totpCode"));
      }
      fields.submitting = false;
    });
  }

  return {
    state, setField, load, finish, replaceAuthenticator, copyTotpKey, copyFocus, copyBlur,
    review: access.review,
    canDismiss: () => !pending.value && access.canDismiss(),
    dispose() { disposed = true; enrolmentTicket++; stops.forEach(stop => stop()); access.dispose(); },
  };
}
