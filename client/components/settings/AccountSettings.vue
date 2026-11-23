<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <SettingsPage title="Your account" description="Change your own password and authenticator for all your vaults." :status="state.error">
    <template v-if="state.view">
      <div class="flex flex-col gap-4">
        <SettingRow label="Login name" short as="value"><template #value><span>{{ state.view.login }}</span></template><CustomButton v-if="!state.busy" type="button" variant="secondary" label="Log out" @click="controller.logout" /></SettingRow>
        <SettingRow label="Sign-in method" short as="value"><span class="whitespace-nowrap">{{ state.methodLabel }}</span></SettingRow>
      </div>
      <form class="flex min-w-0 flex-col gap-4" @submit.prevent="controller.requestChange('password')">
        <h3 class="font-semibold">Change password</h3>
        <CurrentCredentialFields :state="state" :set-field="controller.setField" id="account-current" />
        <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingRow id="account-new-password" label="New password"><PasswordField id="account-new-password" :model-value="state.newPassword" autocomplete="new-password" required @update:model-value="controller.setField('newPassword', $event)" /></SettingRow>
          <SettingRow id="account-confirm-password" label="Confirm new password"><PasswordField id="account-confirm-password" :model-value="state.confirmPassword" autocomplete="new-password" required @update:model-value="controller.setField('confirmPassword', $event)" /></SettingRow>
        </div>
        <SettingsActions><CustomButton v-if="!state.busy" type="submit" variant="cta" label="Change password" /></SettingsActions>
      </form>
      <div class="flex flex-col gap-4 border-t border-theme-border pt-6"><div class="flex flex-wrap items-center justify-between gap-4"><div><h3>Authenticator</h3><p class="max-w-64 text-[13px]">Use a code from your authenticator app when signing in.</p></div><div v-if="!state.busy" class="flex flex-wrap justify-end gap-3"><CustomButton v-if="!state.view.totpEnabled" type="button" variant="secondary" label="Add authenticator" @click="controller.beginAuthenticator('enable')" /><template v-else><CustomButton type="button" variant="secondary" label="Replace authenticator" @click="controller.beginAuthenticator('replace')" /><CustomButton type="button" variant="secondary" label="Remove authenticator" @click="controller.beginAuthenticator('remove')" /></template></div></div></div>
    </template>
    <p v-else-if="state.loading" role="status">Loading your account...</p>
    <IdentityDialog :open="!!state.dialog" :title="state.dialogTitle" :cancel="controller.cancelDialog" wide>
      <form class="flex min-w-0 flex-col gap-6" @submit.prevent="controller.requestChange(state.dialog)">
        <p v-if="state.dialog === 'replace'">Set up your new authenticator before removing the old one.</p>
        <AuthenticatorEnrollment v-if="state.enrollment.candidate || state.enrollment.busy || state.enrollment.error" :state="state.enrollment" :code="state.newTotpCode" code-id="account-new-code" :copy-key="controller.copyKey" @update:code="controller.setField('newTotpCode', $event)" />
        <CurrentCredentialFields :state="state" :set-field="controller.setField" id="account-dialog-current" />
        <p v-if="state.error" role="alert" class="text-theme-danger">{{ state.error }}</p>
        <SettingsActions v-if="!state.busy"><CustomButton type="button" variant="secondary" label="Cancel" @click="controller.cancelDialog" /><CustomButton type="submit" variant="cta" :label="state.dialogTitle" /></SettingsActions>
      </form>
    </IdentityDialog>
    <IdentityDialog :open="!!state.confirmation" :title="state.confirmation?.title" :cancel="controller.cancelConfirmation">
      <p>{{ state.confirmation?.message }}</p>
      <SettingsActions v-if="!state.busy"><CustomButton type="button" variant="secondary" label="Cancel" @click="controller.cancelConfirmation" /><CustomButton type="button" variant="cta" :label="state.confirmation?.confirmLabel" @click="controller.confirmChange" /></SettingsActions><p v-else role="status">Changing your credentials...</p>
    </IdentityDialog>
  </SettingsPage>
</template>
<script setup>
import SettingsPage from './SettingsPage.vue';
import SettingRow from './SettingRow.vue';
import CustomButton from '../CustomButton.vue';
import PasswordField from '../PasswordField.vue';
import CurrentCredentialFields from '../CurrentCredentialFields.vue';
import AuthenticatorEnrollment from '../AuthenticatorEnrollment.vue';
import IdentityDialog from '../IdentityDialog.vue';
import SettingsActions from '../SettingsActions.vue';
const props = defineProps({ controller:{type:Object,required:true} });
const state = props.controller.state;
</script>
