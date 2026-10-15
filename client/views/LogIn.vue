<template>
  <div class="flex h-full flex-col items-center justify-center">
    <Logo class="mb-5" />
    <form @submit.prevent="logIn" class="flex max-w-80 flex-col items-center">
      <TextInput
        v-model="username"
        id="username"
        placeholder="Username"
        class="mb-1"
        autocomplete="username"
        required
      />
      <TextInput
        v-model="password"
        id="password"
        placeholder="Password"
        type="password"
        class="mb-1"
        autocomplete="current-password"
        required
      />
      <TextInput
        v-if="globalStore.config.authType == authTypes.totp"
        v-model="totp"
        id="one-time-code"
        placeholder="2FA Code"
        class="mb-1"
        autocomplete="one-time-code"
        required
      />
      <div class="mb-4 flex">
        <input
          type="checkbox"
          id="remember-me"
          v-model="rememberMe"
          class="mr-1"
        />
        <label for="remember-me">Remember Me</label>
      </div>
      <CtaButton label="Log In" />
    </form>
  </div>
</template>

<script setup>
import { useToast } from "primevue/usetoast";
import { ref } from "vue";
import { useRouter } from "vue-router";

import CtaButton from "../components/CtaButton.vue";
import Logo from "../components/Logo.vue";
import TextInput from "../components/TextInput.vue";
import { authTypes } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { createLoginFlow } from "../loginFlow.js";

const props = defineProps({ redirect: String });

const globalStore = useGlobalStore();
const router = useRouter();
const toast = useToast();

const username = ref("");
const password = ref("");
const totp = ref("");
const rememberMe = ref(false);

const flow = createLoginFlow({
  credentials: () => ({ username: username.value, password: password.value, totp: totp.value, rememberMe: rememberMe.value }),
  clearCredentials: () => {
    username.value = "";
    password.value = "";
    totp.value = "";
  },
  redirect: () => props.redirect,
  navigate: (target) => router.push(target),
  toast,
});
const { logIn } = flow;

// Redirect to home if authentication is disabled.
flow.init(globalStore.config.authType);
</script>
