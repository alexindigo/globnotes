<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <SettingsPage title="Vault Access" description="Choose who can use this vault and what they can do." :status="state.status">
    <div v-if="state.view" class="access-list">
      <div v-for="row in state.rows" :key="row.id" class="access-row" :data-account-row="row.id">
        <SettingRow v-if="row.serverSet" :label="row.login" :help="row.you ? 'You' : ''" short as="value" class="access-server-row"><span class="text-theme-text-muted">Admin, Set by server</span></SettingRow>
        <template v-else>
          <AccessLevelField :id="`access-${row.id}`" :label="row.login" :help="row.you ? 'You' : ''" :options="state.namedLevels" :value="row.level" :readonly="!row.canEdit" @change="controller.setLevel(row.id, $event)" />
          <CustomButton v-if="row.canEdit" type="button" :icon-path="tabClose" :aria-label="`Remove ${row.login}`" variant="text" text-tone="normal" @click="controller.remove(row.id)" />
          <span v-else aria-hidden="true" class="access-remove-slot" />
        </template>
      </div>
      <div class="access-row" data-everybody-row>
        <AccessLevelField id="access-everybody" label="Everybody else" help="Visitors and accounts not listed above" :options="state.everybodyLevels" :value="state.everybody" :readonly="!state.mutable" @change="controller.setEverybody" />
        <span aria-hidden="true" class="access-remove-slot" />
      </div>
    </div>
    <p v-else-if="state.loading" role="status">Loading access...</p>
    <SettingsActions v-if="state.mutable"><CustomButton size="settings" type="button" variant="secondary" label="Add existing account" @click="controller.openDialog('existing')" /><CustomButton size="settings" type="button" variant="secondary" label="Create and add account" @click="controller.openDialog('create')" /></SettingsActions>
    <SettingsActions v-if="state.dirty && state.mutable"><template #start><CustomButton size="settings" type="button" variant="secondary" label="Discard changes" @click="controller.discard" /></template><CustomButton v-if="state.canSave" size="settings" type="button" variant="cta" label="Save access" @click="controller.requestCommit" /></SettingsActions>
    <section v-if="state.view?.declaredAdmin?.pinned" class="access-explanation"><h3 class="font-semibold">Why {{ state.view.declaredAdmin.login }} is always an Admin</h3><p>The server's configuration, for example its Docker settings, makes {{ state.view.declaredAdmin.login }} an Admin of this vault so the owner cannot be locked out of the vault.</p><p>To change or remove this Admin access, change the server's configuration, not this app.</p><p>Changing other people's access here does not remove {{ state.view.declaredAdmin.login }}'s Admin access.</p></section>
    <p v-if="state.error && !state.dialog" role="alert" class="text-theme-danger">{{ state.error }}</p><CustomButton v-if="state.canReview && !state.dialog" type="button" variant="secondary" label="Review current access" @click="controller.review" />
    <CustomButton v-if="state.canCheckCreation && !state.dialog" type="button" variant="secondary" label="Check account creation" @click="controller.reviewCreation" />
    <p v-if="state.checkingCreation" role="status">Checking account creation...</p>
    <IdentityDialog :open="!!state.dialog" :title="state.dialogTitle" :cancel="controller.cancelDialog">
      <form class="flex min-w-0 flex-col gap-6" @submit.prevent="controller.submitDialog">
        <p>{{ state.dialog === 'create' ? 'Create an account with access to this vault in one step.' : 'Add someone who already has an account on this server.' }}</p>
        <SettingRow id="access-login" :label="state.dialog === 'create' ? 'New login name' : 'Login name'"><TextInput id="access-login" variant="field" :model-value="state.login" :readonly="!state.mutable" autocomplete="off" required @update:model-value="controller.setField('login', $event)" /></SettingRow>
        <SettingRow v-if="state.dialog === 'create'" id="access-temporary-password" label="Temporary password"><PasswordField id="access-temporary-password" :model-value="state.temporaryPassword" :readonly="!state.mutable" autocomplete="new-password" required @update:model-value="controller.setField('temporaryPassword', $event)" /></SettingRow>
        <AccessLevelField id="access-add-level" label="Vault access" :options="state.namedLevels" :value="state.level" :readonly="!state.mutable" @change="controller.setField('level', $event)" />
        <template v-if="state.dialog === 'create'"><p>Give {{ state.login || 'the recipient' }} the temporary password privately; they must choose their own before opening notes.</p><p>If this cannot finish, neither the account nor its vault access is added.</p></template>
        <p v-else>Their password and authenticator stay unchanged.</p>
        <p v-if="state.error" role="alert" class="text-theme-danger">{{ state.error }}</p>
        <SettingsActions v-if="!state.busy && !state.provisioningUnknown"><CustomButton size="settings" type="button" variant="secondary" label="Cancel" @click="controller.cancelDialog" /><CustomButton v-if="state.canReview" size="settings" type="button" variant="secondary" label="Review current access" @click="controller.review" /><CustomButton v-else-if="state.mutable" size="settings" type="submit" variant="cta" :label="state.dialog === 'create' ? 'Create and add' : 'Add account'" /></SettingsActions>
        <CustomButton v-if="state.canCheckCreation" type="button" variant="secondary" label="Check account creation" @click="controller.reviewCreation" />
        <p v-if="state.busy" role="status">Adding account...</p>
      </form>
    </IdentityDialog>
    <IdentityDialog :open="!!state.confirmation" :title="state.confirmation?.title" :cancel="controller.cancelConfirmation">
      <template v-if="state.confirmation"><p>You are changing {{ state.confirmation.login }} (you) in this vault.</p><div class="grid grid-cols-2 gap-6 rounded bg-theme-background-elevated p-4"><div>Current access<strong class="block text-lg">{{ state.confirmation.current }}</strong></div><div>New access<strong class="block text-lg">{{ state.confirmation.next }}</strong></div></div><p>{{ state.confirmation.consequence }}</p><p>To become an Admin again, another Admin or the person running this server must restore your access.</p><SettingsActions><CustomButton size="settings" type="button" variant="secondary" label="Cancel" @click="controller.cancelConfirmation" /><CustomButton size="settings" type="button" variant="danger-primary" :label="state.confirmation.confirmLabel" @click="controller.confirmChange" /></SettingsActions></template>
    </IdentityDialog>
  </SettingsPage>
</template>
<script setup>
import { computed } from 'vue';
import SettingsPage from './SettingsPage.vue';
import SettingRow from './SettingRow.vue';
import AccessLevelField from './AccessLevelField.vue';
import CustomButton from '../CustomButton.vue';
import SettingsActions from '../SettingsActions.vue';
import IdentityDialog from '../IdentityDialog.vue';
import TextInput from '../TextInput.vue';
import PasswordField from '../PasswordField.vue';
import { tabClose } from '../../icons.js';
const props = defineProps({ controller: { type: Object, required: true } });
const state = computed(() => props.controller.presentation);
</script>
<style scoped>
.access-list { border-top: 1px solid rgb(var(--theme-border)); }
.access-row { display: grid; grid-template-columns: minmax(0, 1fr) 28px; column-gap: 16px; align-items: center; border-bottom: 1px solid rgb(var(--theme-border)); padding: 16px 8px; min-height: 76px; }
.access-row :deep(.setting-row-label) { font-weight: 600; }
.access-server-row { grid-column: 1 / -1; }
.access-remove-slot { width: 28px; }
.access-explanation { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid rgb(var(--theme-border)); padding-top: 20px; font-size: 14px; }
</style>
