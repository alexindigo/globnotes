<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="pb-4 text-[13px] text-theme-warning" data-inventory-recovery>
    <p>{{ recovery.text }}</p><p v-if="recovery.pendingText" role="status">{{ recovery.pendingText }}</p>
    <SettingsActions>
      <template #start><CustomButton type="button" label="Discard choice…" variant="danger-text" wrap-label :disabled="!recovery.canDiscard" @click="onDiscard" /></template>
      <CustomButton type="button" label="Check current status" variant="text" wrap-label :disabled="!recovery.canReview" @click="onReview" />
      <CustomButton type="button" label="Retry" variant="text" wrap-label :disabled="!recovery.canRetry" @click="onRetry" />
    </SettingsActions>
  </div>
</template>
<script setup>
import SettingsActions from '../SettingsActions.vue';
import CustomButton from '../CustomButton.vue';
defineProps({recovery:{type:Object,required:true},onReview:Function,onRetry:Function,onDiscard:Function});
</script>
