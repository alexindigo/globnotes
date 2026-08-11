<template>
  <Modal v-model="isVisible" :closeHandlerOverride="noop" class="p-5">
    <h1 class="mb-2 text-2xl">Welcome to globnotes</h1>
    <p class="mb-4 text-theme-text-muted">
      First-run setup: choose how to secure your notes.
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
      <CustomButton label="Create Password" style="cta" />
    </form>

    <hr class="mb-4 border-theme-border" />

    <p class="mb-2 text-sm text-theme-text-muted">
      On a trusted home network you can disable authentication entirely.
      <strong>
        Anyone who can reach this server will be able to read and modify
        your notes.
      </strong>
    </p>
    <CustomButton
      label="Disable Authentication"
      style="danger"
      @click="disableAuth"
    />
  </Modal>
</template>

<script setup>
import { useToast } from "primevue/usetoast";
import { ref } from "vue";

import { postSetup } from "../api.js";
import CustomButton from "./CustomButton.vue";
import Modal from "./Modal.vue";
import TextInput from "./TextInput.vue";
import { getToastOptions } from "../helpers.js";

const emit = defineEmits(["completed"]);

const isVisible = ref(true);
const username = ref("");
const password = ref("");
const toast = useToast();

// The modal cannot be dismissed: setup must be completed.
function noop() {}

function createPassword() {
  postSetup({
    mode: "password",
    username: username.value,
    password: password.value,
  })
    .then(() => emit("completed"))
    .catch(setupFailed);
}

function disableAuth() {
  postSetup({ mode: "none" })
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
