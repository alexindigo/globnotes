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
      Welcome to globnotes
    </h1>
    <p class="mb-5 text-theme-text-muted">
      Choose who can read and edit your notes.
    </p>

    <form @submit.prevent="finish" class="flex min-h-0 flex-1 flex-col">
      <div class="grid min-h-0 flex-1 gap-6 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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
                :disabled="pending"
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
        <div class="grid setup-details">
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
                autocomplete="username"
                :disabled="pending || mode !== 'password'"
                :aria-invalid="missingUsername ? 'true' : undefined"
              />
            </div>
            <div>
              <label for="setup-password" class="mb-1 block text-sm font-semibold"
                >Password</label
              >
              <div class="relative">
                <TextInput
                  id="setup-password"
                  ref="passwordInput"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                  :disabled="pending || mode !== 'password'"
                  :aria-invalid="missingPassword ? 'true' : undefined"
                  class="pr-10"
                />
                <button
                  type="button"
                  class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-theme-text-muted hover:text-theme-brand"
                  :aria-pressed="showPassword"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  :disabled="pending || mode !== 'password'"
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
            <p class="text-sm text-theme-text-muted">
              You'll sign in with these details after setup.
            </p>
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
            <label class="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
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

      <!-- Reserved feedback space: populated without shifting the action. -->
      <p
        class="mb-1 mt-2 min-h-[1.25rem] text-sm text-theme-danger"
        role="alert"
      >{{ feedback }}</p>

      <CtaButton
        type="submit"
        :label="pending ? 'Setting up…' : 'Finish setup'"
        :disabled="pending || (mode === 'none' && !acked)"
        :aria-busy="pending"
        class="mt-1"
      />
    </form>
  </Modal>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from "vue";

import { postSetup, resetSetup } from "../api.js";
import { tabClose, tabEye, tabEyeOff } from "../icons.js";
import CtaButton from "./CtaButton.vue";
import Icon from "./Icon.vue";
import Modal from "./Modal.vue";
import TextInput from "./TextInput.vue";

const props = defineProps({
  // First-run setup is mandatory (default); a menu-invoked wizard can be
  // dismissed without changing anything server-side.
  dismissible: { type: Boolean, default: false },
});
const emit = defineEmits(["completed", "dismiss"]);

const isVisible = ref(true);

function dismiss() {
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
const password = ref("");
const showPassword = ref(false);
const acked = ref(false);
const pending = ref(false);
const feedback = ref("");
const missingUsername = ref(false);
const missingPassword = ref(false);
const missingAck = ref(false);

const usernameInput = ref(null);
const passwordInput = ref(null);
const ackCheckbox = ref(null);

// The modal cannot be dismissed: setup must be completed.
function noop() {}

onMounted(() => {
  // Focus the selected radio first so the choice is announced.
  document.getElementById("setup-mode-password")?.focus();
});

// Switching modes resets mode-specific state (acknowledgement, masking,
// stale validation); typed credentials stay in memory.
watch(mode, () => {
  acked.value = false;
  showPassword.value = false;
  feedback.value = "";
  missingUsername.value = false;
  missingPassword.value = false;
  missingAck.value = false;
});

function finish() {
  if (pending.value) return;
  feedback.value = "";
  missingUsername.value = false;
  missingPassword.value = false;
  missingAck.value = false;

  if (mode.value === "password") {
    missingUsername.value = !username.value;
    missingPassword.value = !password.value;
    if (missingUsername.value || missingPassword.value) {
      feedback.value = "Enter a username and password.";
      nextTick(() => {
        const target = missingUsername.value
          ? usernameInput.value
          : passwordInput.value;
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

  pending.value = true;
  const payload = mode.value === "password"
    ? { mode: "password", username: username.value, password: password.value }
    : { mode: mode.value };

  const chain = props.dismissible
    // Menu-invoked: the server still holds the previous setup — wipe it
    // first, then post the new choice. A 409 here means the mode is
    // env-pinned and cannot be changed from the UI.
    ? resetSetup().catch((error) => {
        if (error.response?.status === 409) {
          throw new Error("env-pinned");
        }
        throw error;
      })
    : Promise.resolve();

  chain
    .then(() => postSetup(payload))
    .then(() => {
      // Busy state is retained through the parent-owned handoff.
      emit("completed");
    })
    .catch((error) => {
      feedback.value = error.message === "env-pinned"
        ? "Access mode is pinned by environment configuration."
        : "Setup failed. Please try again.";
      pending.value = false;
    });
}
</script>
