<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <SettingsPage title="Your account" description="Change your own password and authenticator for all your vaults." status-id="account-status" :status="state.dialog || state.confirmation || (!state.view && state.loading) ? '' : state.activity.message">
    <template v-if="state.view">
      <div class="flex flex-col gap-4">
        <SettingRow label="Login name" short as="value"><template #value><span>{{ state.view.login }}</span></template><CustomButton type="button" variant="secondary" label="Log out" :disabled="state.locked" @click="controller.logout" /></SettingRow>
        <SettingRow label="Sign-in method" short as="value"><span class="whitespace-nowrap">{{ state.methodLabel }}</span></SettingRow>
      </div>
      <form class="flex min-w-0 flex-col gap-4" @submit.prevent="controller.requestChange('password')">
        <h3 class="font-semibold">Change password</h3>
        <CurrentCredentialFields :state="state" :set-field="controller.setField" id="account-current" :error-id="state.dialog ? undefined : 'account-status'" />
        <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingRow id="account-new-password" label="New password"><PasswordField id="account-new-password" :model-value="state.newPassword" autocomplete="new-password" required :disabled="state.locked" :aria-invalid="state.activity.invalid?.newPassword" :aria-describedby="state.activity.invalid?.newPassword ? 'account-status' : undefined" @update:model-value="controller.setField('newPassword', $event)" /></SettingRow>
          <SettingRow id="account-confirm-password" label="Confirm new password"><PasswordField id="account-confirm-password" :model-value="state.confirmPassword" autocomplete="new-password" required :disabled="state.locked" :aria-invalid="state.activity.invalid?.confirmPassword" :aria-describedby="state.activity.invalid?.confirmPassword ? 'account-status' : undefined" @update:model-value="controller.setField('confirmPassword', $event)" /></SettingRow>
        </div>
        <SettingsActions><CustomButton type="submit" variant="cta" label="Change password" :disabled="state.locked" /></SettingsActions>
      </form>
      <div class="flex flex-col gap-4 border-t border-theme-border pt-6"><div class="flex flex-wrap items-center justify-between gap-4"><div><h3>Authenticator</h3><p class="max-w-64 text-[13px]">Use a code from your authenticator app when signing in.</p></div><div class="flex flex-wrap justify-end gap-3"><CustomButton v-if="!state.view.totpEnabled" type="button" variant="secondary" label="Add authenticator" :disabled="state.locked" @click="controller.beginAuthenticator('enable')" /><template v-else><CustomButton type="button" variant="secondary" label="Replace authenticator" :disabled="state.locked" @click="controller.beginAuthenticator('replace')" /><CustomButton type="button" variant="secondary" label="Remove authenticator" :disabled="state.locked" @click="controller.beginAuthenticator('remove')" /></template></div></div></div>
    </template>
    <p v-else-if="state.loading" role="status">{{ state.activity.message }}</p>
    <IdentityDialog :open="!!state.dialog" :title="state.dialogTitle" :cancel="controller.cancelDialog" :locked="state.locked" wide>
      <form class="flex min-w-0 flex-col gap-6" @submit.prevent="controller.requestChange(state.dialog)">
        <p v-if="state.dialog === 'replace'">Set up your new authenticator before removing the old one.</p>
        <AuthenticatorEnrollment v-if="state.enrollment.candidate || state.enrollment.busy || state.enrollment.error" :state="state.enrollment" :code="state.newTotpCode" code-id="account-new-code" :copy-key="controller.copyKey" :locked="state.locked" :error-id="state.activity.invalid?.newTotpCode ? 'account-dialog-error' : undefined" @update:code="controller.setField('newTotpCode', $event)" />
        <CurrentCredentialFields :state="state" :set-field="controller.setField" id="account-dialog-current" error-id="account-dialog-error" />
        <p v-if="state.activity.kind === 'refused'" id="account-dialog-error" role="alert" class="text-theme-danger">{{ state.activity.message }}</p>
        <p v-else-if="state.locked" role="status">{{ state.activity.message }}</p>
        <SettingsActions><CustomButton type="button" variant="secondary" label="Cancel" :disabled="state.locked" @click="controller.cancelDialog" /><CustomButton type="submit" variant="cta" :label="state.dialogTitle" :disabled="state.locked" /></SettingsActions>
      </form>
    </IdentityDialog>
    <IdentityDialog :open="!!state.confirmation" :title="state.confirmation?.title" :cancel="controller.cancelConfirmation" :locked="state.locked">
      <p>{{ state.confirmation?.message }}</p>
      <SettingsActions v-if="!state.locked"><CustomButton type="button" variant="secondary" label="Cancel" @click="controller.cancelConfirmation" /><CustomButton type="button" variant="cta" :label="state.confirmation?.confirmLabel" @click="controller.confirmChange" /></SettingsActions><p v-else role="status">{{ state.activity.message }}</p>
    </IdentityDialog>
  </SettingsPage>
</template>
<script setup>
import { computed } from 'vue';
import SettingsPage from './SettingsPage.vue';
import SettingRow from './SettingRow.vue';
import CustomButton from '../CustomButton.vue';
import PasswordField from '../PasswordField.vue';
import CurrentCredentialFields from '../CurrentCredentialFields.vue';
import AuthenticatorEnrollment from '../AuthenticatorEnrollment.vue';
import IdentityDialog from '../IdentityDialog.vue';
import SettingsActions from '../SettingsActions.vue';
const props = defineProps({ controller:{type:Object,required:true} });
const state = computed(() => props.controller.state);
</script>
