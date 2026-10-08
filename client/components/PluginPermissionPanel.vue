<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="plugin-permission-panel flex flex-col gap-4" data-plugin-permission-panel>
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="text-lg font-semibold text-theme-text">{{ plugin?.name ?? view?.pluginId ?? 'Plugin permissions' }}</h3>
      <PluginBrowserBadge :runs-in-browser="plugin?.runsInBrowser ?? view?.runsInBrowser" :browser-components="plugin?.browserComponents ?? view?.browserComponents" />
    </div>
    <PluginTrustNotice />
    <p v-if="!view" class="text-sm text-theme-text-muted">Permission status is unavailable. {{ error }}</p>
    <template v-else>
      <section>
        <h4 class="font-semibold text-theme-text">Sandboxed server permissions</h4>
        <Toggle label="Allow network" :is-on="view.allowNetwork" :disabled="unavailable || busy" :aria-pressed="view.allowNetwork" @click="onMaster(!view.allowNetwork)" />
        <p v-if="!hasServer" class="mt-1 text-sm text-theme-text-muted">No sandboxed server component. These controls do not restrict browser execution.</p>
        <p class="mt-1 text-xs text-theme-text-muted">Off blocks both server network and remote-code imports, keeping approvals. On restores only currently requested, approved rights the parent can delegate.</p>
      </section>
      <PermissionHostRows kind="network" heading="Network data hosts" :rows="view.rows.filter(row=>row.kind==='network')" :disabled="unavailable || busy" :on-approve="scope=>onApprove('network',scope)" :on-delete="row=>onDelete('network',row)" />
      <PermissionHostRows kind="imports" heading="Remote-code import hosts" :rows="view.rows.filter(row=>row.kind==='imports')" :disabled="unavailable || busy" :on-approve="scope=>onApprove('imports',scope)" :on-delete="row=>onDelete('imports',row)" />
      <section v-if="view.pendingRequests.length" class="flex flex-col gap-2" data-pending-permission-requests>
        <h4 class="font-semibold text-theme-text">Pending access requests</h4>
        <div v-for="request in view.pendingRequests" :key="request.id" class="rounded border border-theme-border p-3 text-sm">
          <p>{{ request.kind === 'imports' ? 'Remote-code imports' : 'Network data' }}: {{ request.reason }}</p>
          <CustomButton label="Review access request" :disabled="busy" @click="onRequest(request)" />
        </div>
      </section>
      <p class="text-xs text-theme-text-muted" data-permission-reload>Server reload: {{ view.reload.state }}{{ view.reload.detail ? ' — '+view.reload.detail : '' }}. Stored decisions and Worker readiness are separate.</p>
    </template>
    <p v-if="error" role="alert" class="text-sm text-theme-danger">{{ error }}</p>
    <p v-if="busy" role="status" class="text-sm text-theme-text-muted">Saving permission decision. Your note and settings drafts stay open.</p>
    <div v-if="hasDraft" class="rounded border border-theme-warning p-3 text-sm text-theme-text">
      <p>Your permission choices are retained. Review authoritative status before an explicit retry.</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <CustomButton label="Review updated status" :disabled="busy" @click="onReview" />
        <CustomButton label="Retry reviewed choice" :disabled="busy || unavailable" @click="onRetry" />
        <CustomButton label="Discard permission choice" :disabled="busy" @click="onDiscard" />
      </div>
    </div>
  </section>
</template>
<script setup>
import { computed } from "vue";
import Toggle from "./Toggle.vue";
import CustomButton from "./CustomButton.vue";
import PermissionHostRows from "./PermissionHostRows.vue";
import PluginBrowserBadge from "./PluginBrowserBadge.vue";
import PluginTrustNotice from "./PluginTrustNotice.vue";
const props = defineProps({ plugin: Object, view: Object, busy: Boolean, error: String, hasServer: Boolean, writable: Boolean, hasDraft: Boolean,
  onMaster: { type: Function, required: true }, onApprove: { type: Function, required: true }, onDelete: { type: Function, required: true },
  onReview: { type: Function, default: () => {} }, onRetry: { type: Function, default: () => {} }, onDiscard: { type: Function, default: () => {} }, onRequest: { type: Function, default: () => {} } });
const unavailable = computed(() => !props.writable || !props.hasServer);
</script>
