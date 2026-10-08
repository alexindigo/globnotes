<template>
  <Modal
    v-model="isVisible"
    name="setup"
    :closeHandlerOverride="dismissible ? dismiss : noop"
    anchor="viewport-center"
    labelledby="setup-title"
    trapFocus
    class="p-6"
  >
    <button
      v-if="dismissible"
      type="button"
      aria-label="Dismiss setup"
      class="absolute right-4 top-4 rounded p-1 text-theme-text-muted hover:text-theme-brand"
      @click="dismiss"
    >
      <Icon :icon="tabClose" width="20" height="20" />
    </button>
    <h1 id="setup-title" class="mb-1 text-2xl font-semibold">
      {{ dismissible ? 'Access settings' : 'Welcome to globnotes' }}
    </h1>
    <p class="mb-5 text-theme-text-muted">
      Choose who can read and edit your notes.
    </p>

    <form @submit.prevent="finish" @focusin="onCopyFocus" class="flex flex-1 shrink-0 flex-col">
      <div class="grid min-w-0 flex-1 grid-cols-1 gap-6 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <fieldset class="sm:border-r sm:border-theme-border sm:pr-6">
          <legend class="sr-only">Access mode</legend>
          <div class="flex flex-col gap-2">
            <label
              v-for="option in options"
              :key="option.mode"
              class="flex cursor-pointer items-start gap-3 rounded-md border p-4"
              :class="mode === option.mode
                ? 'border-theme-brand bg-theme-background-elevated'
                : 'border-theme-border opacity-50 transition-opacity hover:border-theme-text-very-muted hover:opacity-100'"
            >
              <input
                type="radio"
                name="access-mode"
                v-model="mode"
                :value="option.mode"
                :id="`setup-mode-${option.mode}`"
                 :disabled="pending || accessLoading || accessView?.pinned.mode"
                :aria-describedby="`setup-desc-${option.mode}`"
                class="mt-1 h-4 w-4 shrink-0 accent-theme-brand"
              />
              <span>
                <span class="font-semibold">{{ option.title }}</span>
                <span
                  :id="`setup-desc-${option.mode}`"
                  class="mt-0.5 block text-sm text-theme-text-muted"
                  >{{ option.description }}</span
                >
              </span>
            </label>
          </div>
        </fieldset>

        <!-- Details: all three panels share one grid cell, so the region keeps
           the tallest panel's height regardless of selection — switching
           modes cannot move or resize the dialog. Inactive panels keep their
           layout footprint (invisible) but are inert, unreadable to AT, and
           their inputs are disabled (no validation, no focus). -->
        <div class="setup-details grid min-w-0 grid-cols-1">
        <!-- Password protected -->
        <div
          class="col-start-1 row-start-1"
          :class="mode !== 'password' ? 'invisible' : ''"
          :inert="mode !== 'password' ? '' : undefined"
          :aria-hidden="mode !== 'password' ? 'true' : undefined"
        >
          <div class="flex flex-col gap-2">
            <div>
              <label for="setup-username" class="mb-1 block text-sm font-semibold"
                >Username</label
              >
              <TextInput
                id="setup-username"
                ref="usernameInput"
                 v-model="username"
                 @update:modelValue="usernameEdited = true"
                autocomplete="username"
                 :disabled="pending || accessLoading || accessView?.pinned.username || mode !== 'password'"
                :aria-invalid="missingUsername ? 'true' : undefined"
              />
            </div>
            <div>
              <label for="setup-password" class="mb-1 block text-sm font-semibold"
                >{{ existingAccount ? 'New password (leave blank to keep it)' : 'Password' }}</label
              >
              <div class="relative">
                <TextInput
                  id="setup-password"
                  ref="passwordInput"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                   :disabled="pending || accessLoading || accessView?.pinned.password || accessView?.pinned.sessions || mode !== 'password'"
                  :aria-invalid="missingPassword ? 'true' : undefined"
                  class="pr-10"
                />
                <button
                  type="button"
                  class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-theme-text-muted hover:text-theme-brand"
                  :aria-pressed="showPassword"
                   :aria-label="showPassword ? 'Hide password' : 'Show password'"
                   :disabled="pending || accessLoading || accessView?.pinned.password || accessView?.pinned.sessions || mode !== 'password'"
                  @click="showPassword = !showPassword"
                >
                  <Icon
                    :icon="showPassword ? tabEye : tabEyeOff"
                    width="20"
                    height="20"
                  />
                </button>
              </div>
            </div>
            <div class="my-2 flex items-center justify-between gap-3 text-sm">
              <div class="min-w-0">
                <p id="setup-totp-label" class="font-semibold">
                  Require an authenticator code
                </p>
                <p id="setup-totp-description" class="text-theme-text-muted">
                  Use your password and authenticator app to sign in.
                </p>
              </div>
              <Toggle
                id="setup-totp"
                type="button"
                role="switch"
                :isOn="totpEnabled"
                :aria-checked="totpEnabled"
                aria-labelledby="setup-totp-label"
                 aria-describedby="setup-totp-description"
                 :disabled="pending || accessLoading || accessView?.pinned.totp || accessView?.pinned.sessions || mode !== 'password'"
                class="shrink-0 text-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-theme-brand disabled:cursor-not-allowed disabled:opacity-50"
                @click="totpEnabled = !totpEnabled"
              />
            </div>
            <div
              v-if="totpEnabled && (!existingTotp || replacingTotp || totpKey)"
              class="setup-totp-enrolment grid grid-cols-1 items-center gap-4 sm:grid-cols-[224px_minmax(0,1fr)]"
            >
              <template v-if="totpSecret">
                <div class="flex w-56 max-w-full flex-col gap-2">
                  <button
                    id="setup-totp-qr"
                    ref="totpQrControl"
                    type="button"
                    aria-label="Copy authenticator setup key"
                    :aria-describedby="copyFeedback ? 'setup-totp-copy-feedback' : undefined"
                    :aria-busy="copying"
                    :disabled="pending || copying || mode !== 'password'"
                    class="block w-full shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme-brand disabled:cursor-not-allowed"
                    @click="copyTotpKey"
                    @blur="onCopyBlur"
                  >
                    <img
                      :src="totpQr"
                      alt="TOTP enrolment QR code"
                      class="block h-auto w-full [image-rendering:pixelated]"
                    />
                  </button>
                  <span
                    v-if="copyFeedback"
                    id="setup-totp-copy-feedback"
                    role="tooltip"
                    aria-live="polite"
                    class="pointer-events-none block w-full break-words rounded-md border border-theme-border bg-theme-background-elevated px-3 py-2 text-xs text-theme-text shadow-md"
                  >{{ copyFeedback }}</span>
                </div>
                <div class="setup-totp-fields flex min-w-0 flex-col gap-4">
                  <p class="text-sm text-theme-text-muted">
                    Scan with your authenticator app, then enter its six-digit code.
                  </p>
                  <div>
                    <label
                      for="setup-totp-code"
                      class="mb-1 block text-sm font-semibold"
                      >{{ dismissible ? 'Code from the new authenticator' : 'Current code' }}</label
                    >
                    <TextInput
                      id="setup-totp-code"
                      ref="totpCodeInput"
                      v-model="totpCode"
                      inputmode="numeric"
                      autocomplete="one-time-code"
                      maxlength="6"
                      placeholder="123456"
                      :disabled="pending || mode !== 'password'"
                      :aria-invalid="missingTotp ? 'true' : undefined"
                    />
                  </div>
                </div>
              </template>
              <p v-else class="col-span-2 text-sm text-theme-text-muted" role="status">
                Generating enrolment key…
              </p>
            </div>
            <button v-if="totpEnabled && existingTotp && !replacingTotp" type="button" :disabled="pending || accessView?.pinned.totp || accessView?.pinned.sessions" class="text-left text-sm text-theme-brand disabled:opacity-50" @click="replaceAuthenticator">Set up a new authenticator</button>
          </div>
        </div>

        <!-- Read-only -->
        <div
          class="col-start-1 row-start-1"
          :class="mode !== 'read_only' ? 'invisible' : ''"
          :inert="mode !== 'read_only' ? '' : undefined"
          :aria-hidden="mode !== 'read_only' ? 'true' : undefined"
        >
          <div>
            <p class="font-semibold">Reading only</p>
            <p class="mt-1 text-sm text-theme-text-muted">
              Visitors can browse and search without signing in. To change
              your notes, edit the files outside globnotes.
            </p>
          </div>
        </div>

        <!-- Open access -->
        <div
          class="col-start-1 row-start-1"
          :class="mode !== 'none' ? 'invisible' : ''"
          :inert="mode !== 'none' ? '' : undefined"
          :aria-hidden="mode !== 'none' ? 'true' : undefined"
        >
          <div>
            <p class="font-semibold">Use on a trusted network</p>
            <p class="mt-1 text-sm text-theme-text-muted">
              Anyone who can reach this server will be able to change your
              notes.
            </p>
            <div class="mt-4 flex items-center justify-between gap-3 text-sm">
              <div><p id="setup-settings-lock-label" class="font-semibold">Read-only settings</p>
                <p id="setup-settings-lock-help" class="text-theme-text-muted">Keep note editing public while locking access, branding and plugin settings. Unlock through deployment configuration.</p></div>
              <Toggle id="setup-read-only-settings" type="button" role="switch" :is-on="readOnlySettings" :aria-checked="readOnlySettings" aria-labelledby="setup-settings-lock-label" aria-describedby="setup-settings-lock-help" :disabled="pending || accessLoading || mode !== 'none' || accessView?.pinned.readOnlySettings" @click="readOnlySettings = !readOnlySettings" />
            </div>
            <label class="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                id="setup-ack"
                ref="ackCheckbox"
                v-model="acked"
                :disabled="pending || mode !== 'none'"
                :aria-invalid="missingAck ? 'true' : undefined"
                class="mt-0.5 h-4 w-4 shrink-0 accent-theme-brand"
              />
              <span>
                I understand that anyone who can reach this server can change
                or delete notes.
              </span>
            </label>
          </div>
        </div>
        </div>
      </div>

      <fieldset v-if="existingAccount" class="mt-4 grid gap-3 border-t border-theme-border pt-3 sm:grid-cols-2">
        <legend class="text-sm font-semibold">Confirm the current login before changing access</legend>
        <div><label for="access-current-password" class="mb-1 block text-sm">Current password</label><TextInput id="access-current-password" v-model="currentPassword" type="password" autocomplete="current-password" :disabled="pending" /></div>
        <div v-if="existingTotp"><label for="access-current-totp" class="mb-1 block text-sm">Code from the current authenticator</label><TextInput id="access-current-totp" v-model="currentTotp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" :disabled="pending" /></div>
      </fieldset>

      <!-- Reserved feedback space: populated without shifting the action. -->
      <p
        class="mb-1 mt-2 min-h-[1.25rem] text-sm text-theme-danger"
        role="alert"
      >{{ feedback || accessState.state.error }}</p>
      <button v-if="accessState.state.needsReview" type="button" :disabled="pending || accessState.state.reviewing" class="text-sm text-theme-brand disabled:opacity-50" @click="accessState.review">Review current access</button>

      <CtaButton
        type="submit"
        :label="pending ? 'Setting up…' : dismissible ? 'Save access settings' : 'Finish setup'"
        :disabled="pending || accessLoading || accessState.state.needsReview || (dismissible && !accessView?.settingsWritable) || (mode === 'none' && !acked)"
        :aria-busy="pending"
        class="mt-1"
      />
    </form>
  </Modal>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { getAccessSettings, getConfig, postAccessTotpEnrolment, postSetup, postTotpEnrolment, putAccessSettings } from "../api.js";
import { createAccessSettingsState } from "../accessSettingsState.js";
import { tabClose, tabEye, tabEyeOff } from "../icons.js";
import CtaButton from "./CtaButton.vue";
import Icon from "./Icon.vue";
import Modal from "./Modal.vue";
import TextInput from "./TextInput.vue";
import Toggle from "./Toggle.vue";

const props = defineProps({
  // First-run setup is mandatory (default); a menu-invoked wizard can be
  // dismissed without changing anything server-side.
  dismissible: { type: Boolean, default: false },
  beforeCommit: { type: Function, default: async () => true },
});
const emit = defineEmits(["completed", "dismiss"]);

const isVisible = ref(true);
const accessState = createAccessSettingsState({ read: getAccessSettings, write: putAccessSettings, readStatus: getConfig, completed: result => emit('completed', result) });
const accessView = computed(() => accessState.state.view);
const accessLoading = computed(() => props.dismissible && (accessState.state.loading || !accessView.value));
const existingAccount = computed(() => props.dismissible && !!accessView.value?.username);
const existingTotp = computed(() => existingAccount.value && accessView.value?.totpEnabled);
const readOnlySettings = ref(false), currentPassword = ref(''), currentTotp = ref(''), replacingTotp = ref(false);
let enrolmentTicket = 0, disposed = false;
onBeforeUnmount(() => { disposed = true; enrolmentTicket++; accessState.dispose(); });

function dismiss() {
  if (pending.value || !accessState.canDismiss()) return;
  isVisible.value = false;
  emit("dismiss");
}

const options = [
  {
    mode: "password",
    title: "Password protected",
    description: "A username and password are required to read or edit notes.",
  },
  {
    mode: "read_only",
    title: "Read-only",
    description:
      "Anyone who can reach this server can read notes. Editing is disabled.",
  },
  {
    mode: "none",
    title: "Open access",
    description:
      "Anyone who can reach this server can read, edit, and delete notes. No sign-in required.",
  },
];

const mode = ref("password");
const username = ref("");
const usernameEdited = ref(false);
watch(accessView, (view, previous) => {
  // An untouched username is omitted intent, not a rename proposal. Review
  // may refresh its display without touching passwords or enrolment state.
  if (view && previous && !usernameEdited.value) username.value = view.username;
});
const password = ref("");
const showPassword = ref(false);
const acked = ref(false);
const submitting = ref(false);
const pending = computed(() => submitting.value || accessState.state.pending || accessState.state.inFlight || accessState.state.reviewing);
const feedback = ref("");
const missingUsername = ref(false);
const missingPassword = ref(false);
const missingAck = ref(false);

// TOTP enrolment: the bundle is minted once per toggle-on and echoed
// back at submit; the entered code proves the user recorded the key.
const totpEnabled = ref(false);
const totpKey = ref("");
const totpSecret = ref("");
const totpQr = ref("");
const totpCode = ref("");
const missingTotp = ref(false);
const copyArmed = ref(false);
const copying = ref(false);
const copyFeedback = ref("");
const totpQrControl = ref(null);
let copyTicket = 0;

function resetCopyConfirmation() {
  copyTicket++;
  copyArmed.value = false;
  copyFeedback.value = "";
}

function onCopyFocus(event) {
  // A disabled pending QR may lose native focus without delivering its blur.
  // The next form control owns a new focus attempt regardless of that event.
  if (!totpQrControl.value?.contains(event.target)) resetCopyConfirmation();
}

function onCopyBlur(event) {
  // Native disabling can blur the busy button without admitting a new focus
  // owner. Keep that attempt; an actual next control retires it via focusin.
  if (copying.value && !event.relatedTarget) return;
  resetCopyConfirmation();
}

async function copyTotpKey() {
  if (pending.value || copying.value || !totpSecret.value) return;
  if (!copyArmed.value) {
    copyArmed.value = true;
    copyFeedback.value = "Click again to copy the setup key.";
    return;
  }
  copyArmed.value = false;
  copying.value = true;
  const secret = totpSecret.value;
  const ticket = copyTicket;
  try {
    await navigator.clipboard.writeText(secret);
    if (!disposed && ticket === copyTicket && totpSecret.value === secret && mode.value === "password") {
      copyFeedback.value = "Setup key copied.";
    }
  } catch {
    if (!disposed && ticket === copyTicket && totpSecret.value === secret && mode.value === "password") {
      copyFeedback.value = "Could not copy the setup key. Please try again.";
    }
  } finally {
    copying.value = false;
  }
}

const usernameInput = ref(null);
const passwordInput = ref(null);
const ackCheckbox = ref(null);
const totpCodeInput = ref(null);

// Mint a fresh bundle each time the toggle comes on; a fetch failure
// rolls the toggle back off with feedback.
watch(totpEnabled, async (enabled) => {
  const ticket = ++enrolmentTicket;
  resetCopyConfirmation();
  missingTotp.value = false;
  totpCode.value = "";
  if (!enabled) {
    totpKey.value = "";
    totpSecret.value = "";
    totpQr.value = "";
    return;
  }
  if (existingTotp.value && !replacingTotp.value) return;
  try {
    const bundle = await (props.dismissible ? postAccessTotpEnrolment : postTotpEnrolment)(username.value);
    if (disposed || ticket !== enrolmentTicket || !totpEnabled.value) return;
    totpKey.value = bundle.key;
    totpSecret.value = bundle.secret;
    totpQr.value = bundle.qr;
  } catch {
    if (disposed || ticket !== enrolmentTicket) return;
    totpKey.value = "";
    totpSecret.value = "";
    totpQr.value = "";
    feedback.value = "Could not start TOTP enrolment. Please try again.";
    totpEnabled.value = false;
  }
});

async function replaceAuthenticator() {
  if (pending.value) return;
  replacingTotp.value = true;
  totpEnabled.value = false;
  await nextTick();
  totpEnabled.value = true;
}

// The modal cannot be dismissed: setup must be completed.
function noop() {}

onMounted(async () => {
  if (props.dismissible) {
    const view = await accessState.load();
    if (view && !disposed) { mode.value = view.mode; username.value = view.username; totpEnabled.value = view.totpEnabled; readOnlySettings.value = view.mode === 'none' ? view.readOnlySettings : true; }
  }
  // Focus the selected radio first so the choice is announced.
  document.getElementById("setup-mode-password")?.focus();
});

// Switching modes resets mode-specific state (acknowledgement, masking,
// stale validation); typed credentials stay in memory.
watch(mode, () => {
  resetCopyConfirmation();
  acked.value = false;
  showPassword.value = false;
  feedback.value = "";
  missingUsername.value = false;
  missingPassword.value = false;
  missingAck.value = false;
});

async function finish() {
  if (pending.value || accessLoading.value || accessState.state.needsReview) return;
  feedback.value = "";
  missingUsername.value = false;
  missingPassword.value = false;
  missingAck.value = false;

  if (mode.value === "password") {
    missingUsername.value = !username.value;
    missingPassword.value = !existingAccount.value && !password.value;
    missingTotp.value = totpEnabled.value && (!existingTotp.value || replacingTotp.value || !!totpKey.value) && !/^\d{6}$/.test(totpCode.value);
    if (missingUsername.value || missingPassword.value || missingTotp.value) {
      feedback.value = missingTotp.value
        ? "Enter the current 6-digit code from your authenticator."
        : "Enter a username and password.";
      nextTick(() => {
        const target = missingUsername.value
          ? usernameInput.value
          : missingPassword.value
          ? passwordInput.value
          : totpCodeInput.value;
        target?.$el?.focus();
      });
      return;
    }
  } else if (mode.value === "none" && !acked.value) {
    missingAck.value = true;
    feedback.value = "Confirm that you understand open access.";
    nextTick(() => ackCheckbox.value?.focus());
    return;
  }

  if (existingAccount.value && (!currentPassword.value || (existingTotp.value && !/^\d{6}$/.test(currentTotp.value)))) {
    feedback.value = 'Confirm your current password and current authenticator code.';
    return;
  }
  const payload = mode.value === "password"
    ? {
      mode: "password",
      username: username.value,
       ...(!existingAccount.value || password.value ? { password: password.value } : {}),
      // The minted key echoes back; the server persists it only after
      // the code checks out.
      ...(totpEnabled.value && totpKey.value
        ? { totpKey: totpKey.value, totpCode: totpCode.value }
        : {}),
    }
    : { mode: mode.value, ...(mode.value === 'none' ? { readOnlySettings: readOnlySettings.value } : {}) };
  if (props.dismissible) {
    const configured = { ...payload, ...(mode.value === 'password' ? { totpEnabled: totpEnabled.value } : {}),
      ...(mode.value === 'none' ? { readOnlySettings: readOnlySettings.value } : {}),
      ...(existingAccount.value ? { currentPassword: currentPassword.value, ...(existingTotp.value ? { currentTotp: currentTotp.value } : {}) } : {}) };
    if (mode.value === 'password' && existingAccount.value && !usernameEdited.value) delete configured.username;
    if (existingTotp.value && !replacingTotp.value && !totpKey.value) { delete configured.totpKey; delete configured.totpCode; }
    await accessState.commit(configured, props.beforeCommit);
    return;
  }

  submitting.value = true;
  try {
    if (await props.beforeCommit() !== true || disposed) {
      submitting.value = false;
      return;
    }
  } catch {
    feedback.value = "Your changes could not be resolved. Keep editing and try again.";
    submitting.value = false;
    return;
  }

  postSetup(payload)
    .then(() => {
      // Busy state is retained through the parent-owned handoff.
      emit("completed");
    })
    .catch((error) => {
      // A 400 carries the server's reason (e.g. the TOTP code didn't
      // match) — show it; anything else stays generic.
      const detail = error.response?.data?.detail;
      feedback.value = error.message === "env-pinned"
        ? "Access mode is pinned by environment configuration."
        : error.response?.status === 400 && detail
        ? detail
        : "Setup failed. Please try again.";
      if (error.response?.status === 400 && totpEnabled.value) {
        // The code is spent or wrong — clear for a fresh one.
        totpCode.value = "";
        nextTick(() => totpCodeInput.value?.$el?.focus());
      }
       submitting.value = false;
    });
}
</script>
