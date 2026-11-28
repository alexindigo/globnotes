<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <form class="identity-login mx-auto grid w-full max-w-80 grid-cols-1 gap-4" @submit.prevent="controller.submit">
    <h1 v-if="!dialog && state.step === 'password'" class="text-center text-lg font-semibold">Sign in</h1>
    <Logo class="justify-self-center" />
    <template v-if="state.step === 'password'">
      <SettingRow id="identity-login-name" label="Login name"><TextInput id="identity-login-name" variant="field" :model-value="state.username" autocomplete="username" required @update:model-value="controller.setField('username', $event)" /></SettingRow>
      <SettingRow id="identity-login-password" label="Password"><PasswordField id="identity-login-password" :model-value="state.password" autocomplete="current-password" required @update:model-value="controller.setField('password', $event)" /></SettingRow>
      <label class="flex items-center justify-center gap-1 whitespace-nowrap"><input type="checkbox" :checked="state.rememberMe" @change="controller.setField('rememberMe', $event.target.checked)" />Remember me</label>
    </template>
    <template v-else>
      <h1 class="text-center text-lg font-semibold">Authenticator code</h1>
      <p class="text-[13px]">Signing in as {{ state.username }}. Enter the current six-digit code from your authenticator app.</p>
      <SettingRow id="identity-login-code" label="Authenticator code"><TextInput id="identity-login-code" variant="field" :model-value="state.totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required @update:model-value="controller.setField('totp', $event)" /></SettingRow>
    </template>
    <CtaButton v-if="!state.busy" type="submit" :label="state.step === 'password' ? 'Continue' : 'Sign in'" />
    <p v-else role="status">Signing in...</p>
    <CustomButton v-if="state.step === 'authenticator' && !state.busy" type="button" variant="secondary" label="Use another account" @click="controller.useAnotherAccount" />
  </form>
</template>
<script setup>
import { computed } from 'vue';
import TextInput from './TextInput.vue';
import PasswordField from './PasswordField.vue';
import CtaButton from './CtaButton.vue';
import CustomButton from './CustomButton.vue';
import Logo from './Logo.vue';
import SettingRow from './settings/SettingRow.vue';
const props = defineProps({ controller:{type:Object,required:true}, dialog:Boolean });
const state = computed(() => props.controller.state);
</script>
