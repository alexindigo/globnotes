<template>
  <Modal v-model="isVisible" name="setup" :closeHandlerOverride="noop" class="p-5">
    <h1 class="mb-2 text-2xl">Welcome to globnotes</h1>
    <p class="mb-4 text-theme-text-muted">
      First-run setup: choose how to secure your notes.
    </p>

    <p v-if="namespaced" class="mb-4 text-sm">
      Access:
      <select v-model="access" class="ml-2 border border-theme-border bg-theme-background">
        <option value="public">Public</option>
        <option value="private">Private</option>
        <option value="hidden">Hidden</option>
        <option value="secret">Secret</option>
      </select>
    </p>

    <form @submit.prevent="createPassword" class="mb-4 flex flex-col">
      <TextInput
        v-model="username"
        placeholder="Username"
        class="mb-1"
        autocomplete="username"
        required
      />
      <TextInput
        v-model="password"
        placeholder="Password"
        type="password"
        class="mb-2"
        autocomplete="new-password"
        required
      />
      <CustomButton label="Create Password" variant="cta" />
    </form>

    <hr class="mb-4 border-theme-border" />

    <p class="mb-2 text-sm text-theme-text-muted">
      Or choose open access on a trusted network:
    </p>
    <div class="flex gap-2">
      <CustomButton
        label="Read-Only"
        variant="cta"
        @click="chooseReadOnly"
      />
      <CustomButton
        label="Disable Authentication"
        variant="danger"
        @click="disableAuth"
      />
    </div>
    <p class="mt-2 text-sm text-theme-text-muted">
      <strong>Read-only:</strong> anyone can browse and search, nobody can
      edit (family wiki; editing happens elsewhere).
      <strong>Disable auth:</strong> anyone who can reach this server can
      read <em>and modify</em> your notes.
    </p>
  </Modal>
</template>

<script setup>
import { useToast } from "primevue/usetoast";
import { ref } from "vue";

import { postSetup } from "../api.js";
import { namespaced } from "../vault.js";
import CustomButton from "./CustomButton.vue";
import Modal from "./Modal.vue";
import TextInput from "./TextInput.vue";
import { getToastOptions } from "../helpers.js";

const emit = defineEmits(["completed"]);

const isVisible = ref(true);
const username = ref("");
const password = ref("");
const access = ref("private");
const toast = useToast();

// The modal cannot be dismissed: setup must be completed.
function noop() {}

function payload(extra) {
  return namespaced ? { access: access.value, ...extra } : extra;
}

function createPassword() {
  postSetup(payload({
    mode: "password",
    username: username.value,
    password: password.value,
  }))
    .then(() => emit("completed"))
    .catch(setupFailed);
}

function chooseReadOnly() {
  postSetup(payload({ mode: "read_only" }))
    .then(() => emit("completed"))
    .catch(setupFailed);
}

function disableAuth() {
  postSetup(payload({ mode: "none" }))
    .then(() => emit("completed"))
    .catch(setupFailed);
}

function setupFailed(error) {
  console.error(error);
  toast.add(
    getToastOptions("Setup failed. Please try again.", "Error", "error"),
  );
}
</script>
