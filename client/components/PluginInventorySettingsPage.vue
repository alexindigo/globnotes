<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="plugin-inventory flex min-w-0 flex-col gap-4" data-plugin-inventory>
    <PluginTrustNotice />
    <SettingRow class="plugin-policy-row" label="Turn on new plugins automatically" :as="autoEnable.canToggle ? 'control' : 'value'" :pin="autoEnable.note" short>
      <template #default="{ id, labelledby }"><Toggle v-if="autoEnable.canToggle" :id="id" :aria-labelledby="labelledby" :is-on="autoEnable.value" @click="onAutoEnable" /><span v-else class="settings-text">{{ autoEnable.value ? 'On' : 'Off' }}</span></template>
    </SettingRow>
    <InventoryRecovery v-if="autoEnable.recovery" :recovery="autoEnable.recovery" :on-review="onPolicyReview" :on-retry="onPolicyRetry" :on-discard="onPolicyDiscard" />
    <div>
      <PluginRow v-for="row in rows" :key="row.id" :row="row" :on-expand="()=>onExpansion(row.id)">
        <template v-if="row.pages.length" #actions>
          <CustomButton size="settings" type="button" label="Open settings" variant="secondary" :aria-label="row.openSettingsLabel" wrap-label :data-settings-page-id="row.pages[0].id" @click="onOpenPage(row.pages[0].id)" />
        </template>
        <template #toggle>
          <Toggle v-if="row.canToggle" :is-on="row.enabled" :aria-label="`Enable ${row.name}`" @click="onEnabled(row.id)" />
          <span v-else class="settings-text">{{ row.enabled ? 'On' : 'Off' }}</span>
        </template>
        <PluginPermissions :view="row.permission" :on-master="onMaster" :on-host="onHost" :on-review="onReview" :on-retry="onRetry" :on-discard="onDiscard" />
        <template #recovery><InventoryRecovery v-if="row.recovery" :recovery="row.recovery" :on-review="onPolicyReview" :on-retry="onPolicyRetry" :on-discard="onPolicyDiscard" /></template>
      </PluginRow>
    </div>
  </section>
</template>
<script setup>
import Toggle from './Toggle.vue';
import CustomButton from './CustomButton.vue';
import InventoryRecovery from './settings/InventoryRecovery.vue';
import PluginTrustNotice from './PluginTrustNotice.vue';
import SettingRow from './settings/SettingRow.vue';
import PluginRow from './settings/PluginRow.vue';
import PluginPermissions from './settings/PluginPermissions.vue';
defineProps({ rows:{type:Array,default:()=>[]}, autoEnable:{type:Object,default:()=>({})},
  onOpenPage:Function, onAutoEnable:Function, onEnabled:Function, onExpansion:Function,
  onPolicyReview:Function, onPolicyRetry:Function, onPolicyDiscard:Function,
  onMaster:Function, onHost:Function, onReview:Function, onRetry:Function, onDiscard:Function });
</script>
