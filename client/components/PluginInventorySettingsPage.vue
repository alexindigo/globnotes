<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]" data-plugin-inventory>
    <PluginTrustNotice />
    <p class="text-xs text-theme-text-muted">Enablement is vault policy shared by every browser; old per-browser switches remain legacy preferences only. Filesystem-added plugins appear here for permission review.</p>
    <div class="flex flex-wrap items-center gap-2">
      <Toggle class="inventory-toggle" label="Auto-enable new plugins" :is-on="policy?.effectiveAutoEnable ?? true" :disabled="!writable || snapshot?.hasWork || policy?.autoEnableSource==='environment'" @click="onAutoEnable" />
      <span v-if="policy?.autoEnableSource==='environment'" class="text-xs text-theme-text-muted">Pinned by environment</span>
    </div>
    <p v-if="errors.__policy" role="alert" class="text-sm text-theme-danger">{{ errors.__policy }}</p>
    <p v-if="snapshot?.busy" role="status" class="text-sm text-theme-text-muted">Inventory policy work is pending. Settings and session handoffs wait for its owned outcome.</p>
    <p v-if="snapshot?.error" role="alert" class="text-sm text-theme-danger">{{ snapshot.error }}</p>
    <SettingsActions v-if="snapshot?.intent" data-inventory-recovery>
      <template #start><CtaButton type="button" label="Review current policy" :disabled="!snapshot.canReview" @click="onPolicyReview" /></template>
      <template #end>
        <CtaButton type="button" label="Retry same policy choice" :disabled="!snapshot.canRetry" @click="onPolicyRetry" />
        <CtaButton type="button" intent="danger" label="Resolve local choice" :disabled="!snapshot.canDiscard" @click="onPolicyDiscard" />
      </template>
    </SettingsActions>
    <article v-for="plugin in plugins" :key="plugin.id" class="min-w-0 rounded border border-theme-border p-1 sm:p-3" :data-plugin-inventory-id="plugin.id">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <span class="min-w-0 font-medium text-theme-text">{{ plugin.name }}</span>
          <PluginBrowserBadge :runs-in-browser="plugin.runsInBrowser" :browser-components="plugin.browserComponents" />
        </div>
        <Toggle class="inventory-toggle" :label="plugin.enabled ? 'Enabled' : 'Disabled'" :is-on="plugin.enabled" :disabled="!writable || snapshot?.hasWork" @click="onEnabled(plugin,!plugin.enabled)" />
      </div>
      <p v-if="plugin.blocking?.actions?.length" class="mt-1 text-sm text-theme-warning">Can block actions: {{ plugin.blocking.actions.join(', ') }}. Errors and timeouts also cancel. {{ plugin.blocking.active ? '' : '(inactive — disabled)' }}</p>
      <p v-if="plugin.status==='failed'" class="mt-1 text-sm text-theme-danger">Failed: {{ plugin.diagnostics?.[0]?.detail ?? 'runtime error' }}</p>
      <p v-if="errors[plugin.id]" role="alert" class="mt-1 text-sm text-theme-danger">{{ errors[plugin.id] }}</p>
       <SettingsActions class="mt-4">
         <template v-if="pagesByPlugin[plugin.id]?.length" #start>
           <CtaButton v-for="page in pagesByPlugin[plugin.id]" :key="page.id" type="button"
             :label="page.label" :data-settings-page-id="page.id" @click="onOpenPage(page.id)" />
         </template>
         <template #end><CtaButton type="button" label="Permissions" @click="onReview(plugin.id)" /></template>
       </SettingsActions>
    </article>
  </section>
</template>
<script setup>
import Toggle from "./Toggle.vue";
import CtaButton from "./CtaButton.vue";
import SettingsActions from "./SettingsActions.vue";
import PluginBrowserBadge from "./PluginBrowserBadge.vue";
import PluginTrustNotice from "./PluginTrustNotice.vue";
defineProps({ plugins: { type: Array, default: () => [] }, pagesByPlugin: { type: Object, default: () => ({}) }, onOpenPage: Function,
   policy: Object, writable: Boolean, snapshot: Object, errors: { type: Object, default: () => ({}) },
   onAutoEnable: { type: Function, required: true }, onEnabled: { type: Function, required: true }, onReview: { type: Function, required: true },
   onPolicyReview: Function, onPolicyRetry: Function, onPolicyDiscard: Function });
</script>

<style scoped>
.inventory-toggle {
  max-width: 100%;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
