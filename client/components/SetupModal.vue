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
      class="focus-ring absolute right-4 top-4 rounded p-1 text-theme-text-muted hover:text-theme-brand"
      @click="dismiss"
    >
      <Icon :icon="tabClose" width="20" height="20" />
    </button>
    <h1 id="setup-title" class="mb-1 text-lg font-semibold">
      {{ dismissible ? 'Access settings' : 'Welcome to globnotes' }}
    </h1>
    <p class="mb-5 text-theme-text-muted">
      Choose who can read and edit your notes.
    </p>

    <form @submit.prevent="finish" @focusin="onCopyFocus" class="flex min-w-0 flex-1 shrink-0 flex-col [overflow-wrap:anywhere]">
      <div class="grid min-w-0 flex-1 grid-cols-1 gap-6 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <fieldset class="min-w-0 sm:border-r sm:border-theme-border sm:pr-6">
          <legend class="sr-only">Access mode</legend>
          <div class="flex flex-col gap-2">
            <label
              v-for="option in options"
              :key="option.mode"
              class="flex cursor-pointer items-start gap-3 rounded p-4"
              :class="{'bg-theme-background-elevated':mode === option.mode}"
            >
              <input
                type="radio"
                name="access-mode"
                v-model="mode"
                :value="option.mode"
                :id="`setup-mode-${option.mode}`"
                :disabled="state.disabled.mode"
                :aria-describedby="`setup-desc-${option.mode}`"
                class="focus-ring mt-1 h-4 w-4 shrink-0 accent-theme-brand"
              />
              <span class="min-w-0">
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
              <label for="setup-username" class="mb-1 block text-sm"
                >Username</label
              >
              <TextInput
                id="setup-username"
                ref="usernameInput"
                v-model="username"
                autocomplete="username"
                :disabled="state.disabled.username"
                :aria-invalid="missingUsername ? 'true' : undefined"
              />
            </div>
            <div>
              <label for="setup-password" class="mb-1 block text-sm"
                >{{ existingAccount ? 'New password (leave blank to keep it)' : 'Password' }}</label
              >
              <div class="flex min-w-0 items-center gap-4">
                <TextInput
                  id="setup-password"
                  ref="passwordInput"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                  :disabled="state.disabled.password"
                  :aria-invalid="missingPassword ? 'true' : undefined"
                  class="flex-1"
                />
                <CustomButton
                  type="button"
                  variant="text"
                  class="shrink-0"
                  :aria-pressed="showPassword"
                   :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  :disabled="state.disabled.password"
                  @click="showPassword = !showPassword"
                >
                  <Icon
                    :icon="showPassword ? tabEye : tabEyeOff"
                    width="20"
                    height="20"
                  />
                </CustomButton>
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
                :disabled="state.disabled.totp"
                class="focus-ring shrink-0 text-2xl disabled:cursor-not-allowed disabled:opacity-50"
                @click="totpEnabled = !totpEnabled"
              />
            </div>
            <div
              v-if="state.showEnrolment"
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
                    :disabled="state.disabled.qr"
                    class="focus-ring block w-full shrink-0 disabled:cursor-not-allowed"
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
                      class="mb-1 block text-sm"
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
                      :disabled="state.disabled.code"
                      :aria-invalid="missingTotp ? 'true' : undefined"
                    />
                  </div>
                </div>
              </template>
              <p v-else class="col-span-2 text-sm text-theme-text-muted" role="status">
                Generating enrolment key…
              </p>
            </div>
            <CustomButton v-if="state.showReplacement" type="button" variant="secondary" label="Set up a new authenticator" wrap-label :disabled="state.disabled.replaceAuthenticator" class="self-start" @click="form.replaceAuthenticator" />
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
              <Toggle id="setup-read-only-settings" type="button" role="switch" :is-on="readOnlySettings" :aria-checked="readOnlySettings" aria-labelledby="setup-settings-lock-label" aria-describedby="setup-settings-lock-help" :disabled="state.disabled.readOnlySettings" @click="readOnlySettings = !readOnlySettings" />
            </div>
            <label class="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                id="setup-ack"
                ref="ackCheckbox"
                v-model="acked"
                :disabled="state.disabled.ack"
                :aria-invalid="missingAck ? 'true' : undefined"
                class="focus-ring mt-0.5 h-4 w-4 shrink-0 accent-theme-brand"
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
        <div><label for="access-current-password" class="mb-1 block text-sm">Current password</label><TextInput id="access-current-password" v-model="currentPassword" type="password" autocomplete="current-password" :disabled="state.disabled.proof" /></div>
        <div v-if="existingTotp"><label for="access-current-totp" class="mb-1 block text-sm">Code from the current authenticator</label><TextInput id="access-current-totp" v-model="currentTotp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" :disabled="state.disabled.proof" /></div>
      </fieldset>

      <!-- Reserved feedback space: populated without shifting the action. -->
      <p
        class="mb-1 mt-2 min-h-[1.25rem] text-sm text-theme-danger"
        role="alert"
      >{{ state.message }}</p>
      <CustomButton v-if="state.needsReview" type="button" variant="secondary" label="Review current access" :disabled="state.disabled.review" class="self-start" @click="form.review" />

      <CtaButton
        type="submit"
        :label="state.submitLabel"
        :disabled="state.disabled.submit"
        :aria-busy="pending"
        class="mt-1 w-full"
      />
    </form>
  </Modal>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, toRefs } from "vue";

import { createSetupFormState, setupOptions as options } from "../setupFormState.js";
import { tabClose, tabEye, tabEyeOff } from "../icons.js";
import CustomButton from "./CustomButton.vue";
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
const usernameInput = ref(null);
const passwordInput = ref(null);
const ackCheckbox = ref(null);
const totpCodeInput = ref(null);
const totpQrControl = ref(null);
const form = createSetupFormState({
  dismissible: () => props.dismissible,
  beforeCommit: () => props.beforeCommit(),
  completed: (...args) => emit("completed", ...args),
  focus(name) {
    const target = { username: usernameInput, password: passwordInput, totpCode: totpCodeInput, ack: ackCheckbox }[name]?.value;
    target?.focus();
  },
});
const state = form.state;
const { pending, existingAccount, existingTotp, totpSecret, totpQr, copying, copyFeedback,
  missingUsername, missingPassword, missingAck, missingTotp } = toRefs(state);
// Writable Vue bindings forward form intent; the controller owns the values.
function field(name) {
  return computed({ get: () => state[name], set: value => form.setField(name, value) });
}
const mode = field("mode"), username = field("username"), password = field("password");
const showPassword = field("showPassword"), acked = field("acked"), totpEnabled = field("totpEnabled");
const totpCode = field("totpCode"), readOnlySettings = field("readOnlySettings");
const currentPassword = field("currentPassword"), currentTotp = field("currentTotp");
const finish = form.finish, copyTotpKey = form.copyTotpKey;
onBeforeUnmount(form.dispose);

function dismiss() {
  if (!form.canDismiss()) return;
  isVisible.value = false;
  emit("dismiss");
}

function onCopyFocus(event) {
  form.copyFocus(!!totpQrControl.value?.contains(event.target));
}

function onCopyBlur(event) {
  form.copyBlur(!!event.relatedTarget);
}

// The modal cannot be dismissed: setup must be completed.
function noop() {}

onMounted(async () => {
  if (props.dismissible) await form.load();
  // Focus the selected radio first so the choice is announced.
  document.getElementById("setup-mode-password")?.focus();
});
</script>
