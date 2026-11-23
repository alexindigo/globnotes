<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <form class="flex w-full max-w-[500px] flex-col gap-6" @submit.prevent="controller.completeRequired">
    <header><h1 class="text-lg font-semibold">Choose your password</h1><p class="mt-2 text-sm">You signed in as {{ state.view?.login }} with a temporary password.</p></header>
    <p class="text-sm">Choose your own password before opening notes; you can add an authenticator later in Your account.</p>
    <SettingRow id="required-new-password" label="New password"><PasswordField id="required-new-password" :model-value="state.newPassword" autocomplete="new-password" required @update:model-value="controller.setField('newPassword', $event)" /></SettingRow>
    <SettingRow id="required-confirm-password" label="Confirm new password"><PasswordField id="required-confirm-password" :model-value="state.confirmPassword" autocomplete="new-password" required @update:model-value="controller.setField('confirmPassword', $event)" /></SettingRow>
    <p v-if="state.error" role="alert" class="text-theme-danger">{{ state.error }}</p>
    <template v-if="!state.busy"><CustomButton type="submit" variant="cta" label="Change password" /><CustomButton type="button" variant="text" text-tone="normal" label="Log out" @click="controller.logout" /></template><p v-else role="status">Changing your password...</p>
  </form>
  <IdentityDialog :open="state.dialog === 'required-proof'" title="Confirm your authenticator" :cancel="controller.cancelDialog">
    <form class="flex flex-col gap-6" @submit.prevent="controller.completeRequired"><p>Enter a fresh code from your authenticator app to change your password.</p><CurrentCredentialFields :state="state" :set-field="controller.setField" id="required-proof" code-only /><p v-if="state.error" role="alert" class="text-theme-danger">{{ state.error }}</p><SettingsActions v-if="!state.busy"><CustomButton type="button" variant="secondary" label="Cancel" @click="controller.cancelDialog" /><CustomButton type="submit" variant="cta" label="Change password" /></SettingsActions></form>
  </IdentityDialog>
</template>
<script setup>
import PasswordField from './PasswordField.vue';
import CustomButton from './CustomButton.vue';
import CurrentCredentialFields from './CurrentCredentialFields.vue';
import IdentityDialog from './IdentityDialog.vue';
import SettingsActions from './SettingsActions.vue';
import SettingRow from './settings/SettingRow.vue';
const props = defineProps({ controller:{type:Object,required:true} });
const state = props.controller.state;
</script>
