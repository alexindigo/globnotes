<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="pb-4 settings-help text-theme-warning" data-inventory-recovery>
    <p>{{ recovery.text }}</p><p v-if="recovery.pendingText" role="status">{{ recovery.pendingText }}</p>
    <SettingsActions>
      <template #start><CustomButton size="settings" v-if="recovery.canDiscard" type="button" label="Discard choice…" variant="danger" wrap-label @click="onDiscard" /></template>
      <CustomButton size="settings" v-if="recovery.canReview" type="button" label="Check current status" variant="secondary" wrap-label @click="onReview" />
      <CustomButton size="settings" v-if="recovery.canRetry" type="button" label="Retry" variant="secondary" wrap-label @click="onRetry" />
    </SettingsActions>
  </div>
</template>
<script setup>
import SettingsActions from '../SettingsActions.vue';
import CustomButton from '../CustomButton.vue';
defineProps({recovery:{type:Object,required:true},onReview:Function,onRetry:Function,onDiscard:Function});
</script>
