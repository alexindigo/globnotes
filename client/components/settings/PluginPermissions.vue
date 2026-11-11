<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="plugin-permissions" data-plugin-permission-panel>
    <template v-if="view.available">
    <SettingRow label="Allow network" :as="view.canChange ? 'control' : 'value'" help="Off blocks network and remote imports for the plugin's server code. Approvals are kept." short>
      <template #default="{ id, labelledby, describedby }"><Toggle v-if="view.canChange" :id="id" :is-on="view.allowNetwork" :aria-labelledby="labelledby" :aria-describedby="describedby" @click="onMaster(view.id)" /><span v-else class="settings-text">{{ view.allowNetwork ? 'On' : 'Off' }}</span></template>
    </SettingRow>
    <SettingsSection v-for="section in [{ id:'network', label:'Network hosts', rows:view.network }, { id:'imports', label:'Remote code imports', rows:view.imports }]" :key="section.id" :title="section.label">
      <p v-if="!section.rows.length" class="permission-quiet">None requested.</p>
      <div v-for="row in section.rows" :key="row.key" class="permission-host" :data-permission-kind="section.id" :data-permission-scope="row.key">
        <div class="permission-host-line"><span>{{ row.label }}</span><span :class="row.tone === 'success' ? 'text-theme-success' : 'permission-quiet'">{{ row.status }}</span>
          <CustomButton size="settings" v-if="row.action && view.canChange" type="button" :label="row.action.label" :aria-label="row.actionLabel" :variant="row.action.danger ? 'danger' : 'secondary'" @click="onHost(view.id,section.id,row)" />
        </div>
        <p v-if="row.warning" class="text-theme-warning settings-help">{{ row.warning }}</p>
      </div>
    </SettingsSection>
    <SettingsSection v-if="view.requests.length" title="Access requests">
      <div v-for="request in view.requests" :key="request.id" class="permission-request" data-pending-permission-requests>
        <span>{{ request.label }}</span><CustomButton size="settings" v-if="request.canReview" type="button" label="Review request…" variant="secondary" wrap-label :aria-label="request.reviewLabel" @click="request.open()" />
      </div>
    </SettingsSection>
    </template>
    <div v-else class="permission-quiet" role="status">
      <p>Permission status unavailable.</p>
      <CustomButton size="settings" v-if="view.canReviewStatus" type="button" label="Check current status" variant="secondary" wrap-label @click="onReview(view.id)" />
    </div>
    <p v-if="view.pendingText" class="permission-quiet" role="status">{{ view.pendingText }}</p>
    <p v-if="view.reloadText" class="permission-quiet">{{ view.reloadText }}</p>
    <p v-if="view.error" class="text-theme-danger settings-help" role="alert">{{ view.error }}</p>
    <div v-if="view.recovery" class="permission-recovery">
      <p class="text-theme-warning">{{ view.recovery.text }}</p>
      <SettingsActions><template #start><CustomButton size="settings" v-if="view.recovery.canDiscard" type="button" label="Discard choice…" variant="danger" wrap-label @click="onDiscard(view.id)" /></template><CustomButton size="settings" v-if="view.recovery.canReview" type="button" label="Check current status" variant="secondary" wrap-label @click="onReview(view.id)" /><CustomButton size="settings" v-if="view.recovery.canRetry" type="button" label="Retry" variant="secondary" wrap-label @click="onRetry(view.id)" /></SettingsActions>
    </div>
  </div>
</template>
<script setup>
import SettingRow from './SettingRow.vue';
import SettingsSection from './SettingsSection.vue';
import Toggle from '../Toggle.vue';
import CustomButton from '../CustomButton.vue';
import SettingsActions from '../SettingsActions.vue';
defineProps({ view:Object, onMaster:Function, onHost:Function, onReview:Function, onRetry:Function, onDiscard:Function });
</script>
<style scoped>
.plugin-permissions { display:flex; flex-direction:column; gap:2rem; min-width:0; }
.permission-quiet { font-size:13px; color:rgb(var(--theme-quiet)); }
.permission-host + .permission-host { border-top:1px solid rgb(var(--theme-border)); padding-top:0.75rem; }
.permission-host-line { display:flex; flex-wrap:wrap; align-items:center; gap:0.25rem 1rem; font-size:13px; }
.permission-host-line > :first-child { flex:1; min-width:0; }
@media(max-width:639px) {
  .permission-host-line { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:0.25rem 0.75rem; }
  .permission-host-line > :first-child { grid-column:1; }
  .permission-host-line > :nth-child(2) { grid-column:1; grid-row:2; }
  .permission-host-line > button { grid-column:2; grid-row:1 / span 2; }
}
.permission-request { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:0.25rem 1rem; font-size:13px; }
.permission-request > span { flex:1; min-width:min(8rem,100%); }
.permission-recovery { display:flex; flex-direction:column; gap:0.5rem; font-size:13px; }
</style>
