<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <form class="flex w-full max-w-[500px] flex-col gap-6" @submit.prevent="controller.completeRequired">
    <header><h1 class="text-lg font-semibold">Choose your password</h1><p class="mt-2 text-sm">You signed in as {{ state.view?.login }} with a temporary password.</p></header>
    <p class="text-sm">Choose your own password before opening notes; you can add an authenticator later in Your account.</p>
    <SettingRow id="required-new-password" label="New password"><PasswordField id="required-new-password" :model-value="state.newPassword" autocomplete="new-password" required :disabled="state.locked" :aria-invalid="state.activity.invalid?.newPassword" :aria-describedby="state.activity.invalid?.newPassword ? 'required-password-error' : undefined" @update:model-value="controller.setField('newPassword', $event)" /></SettingRow>
    <SettingRow id="required-confirm-password" label="Confirm new password"><PasswordField id="required-confirm-password" :model-value="state.confirmPassword" autocomplete="new-password" required :disabled="state.locked" :aria-invalid="state.activity.invalid?.confirmPassword" :aria-describedby="state.activity.invalid?.confirmPassword ? 'required-password-error' : undefined" @update:model-value="controller.setField('confirmPassword', $event)" /></SettingRow>
    <p v-if="!state.dialog && state.activity.kind === 'refused'" id="required-password-error" role="alert" class="text-theme-danger">{{ state.activity.message }}</p>
    <template v-if="!state.locked"><CustomButton type="submit" variant="cta" label="Change password" /><CustomButton type="button" variant="text" text-tone="normal" label="Log out" @click="controller.logout" /></template><p v-else-if="!state.dialog" role="status">{{ state.activity.message }}</p>
  </form>
  <IdentityDialog :open="state.dialog === 'required-proof'" title="Confirm your authenticator" :cancel="controller.cancelDialog" :locked="state.locked">
    <form class="flex flex-col gap-6" @submit.prevent="controller.completeRequired">
      <p>Enter a fresh code from your authenticator app to change your password.</p>
      <CurrentCredentialFields :state="state" :set-field="controller.setField" id="required-proof" code-only error-id="required-proof-error" />
      <p v-if="state.activity.kind === 'refused'" id="required-proof-error" role="alert" class="text-theme-danger">{{ state.activity.message }}</p>
      <p v-else-if="state.locked" role="status">{{ state.activity.message }}</p>
      <SettingsActions><CustomButton type="button" variant="secondary" label="Cancel" :disabled="state.locked" @click="controller.cancelDialog" /><CustomButton type="submit" variant="cta" label="Change password" :disabled="state.locked" /></SettingsActions>
    </form>
  </IdentityDialog>
</template>
<script setup>
import { computed } from 'vue';
import PasswordField from './PasswordField.vue';
import CustomButton from './CustomButton.vue';
import CurrentCredentialFields from './CurrentCredentialFields.vue';
import IdentityDialog from './IdentityDialog.vue';
import SettingsActions from './SettingsActions.vue';
import SettingRow from './settings/SettingRow.vue';
const props = defineProps({ controller:{type:Object,required:true} });
const state = computed(() => props.controller.state);
</script>
