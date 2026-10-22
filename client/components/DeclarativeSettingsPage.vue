<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="flex min-w-0 flex-col gap-4" data-declarative-settings>
    <p v-if="snapshot.blockingText" class="text-[13px] text-theme-warning" role="note">{{ snapshot.blockingText }}</p>
    <div v-if="snapshot.recovery.visible" class="flex min-w-0 flex-col gap-2 text-[13px]" data-declarative-recovery>
      <template v-if="snapshot.status === 'conflict'">
        <p class="text-theme-warning">These settings changed elsewhere. Your edits are kept.</p>
        <SettingsActions><template #start><CustomButton type="button" label="Reload (discards your edits)…" variant="danger-text" wrap-label @click="$emit('reload')" /></template><CustomButton type="button" label="Keep editing" variant="text" wrap-label @click="fieldStart?.focus()" /></SettingsActions>
      </template>
      <template v-else-if="snapshot.status === 'error'">
        <p class="text-theme-danger" role="alert">{{ snapshot.message }} Your edit is kept.</p>
        <SettingsActions><CustomButton type="button" :label="snapshot.recovery.label" variant="text" wrap-label :disabled="!snapshot.canRetry" @click="$emit('retry')" /></SettingsActions>
      </template>
      <p v-if="!snapshot.available" role="status" class="text-theme-warning">This page is unavailable. Your draft is retained for recovery.</p>
      <p v-if="snapshot.changedDescriptor" role="status" class="text-theme-warning">The page definition changed. Your original draft is retained; discard explicitly to load the new definition.</p>
      <pre v-if="!snapshot.available || snapshot.changedDescriptor" tabindex="0" class="focus-ring">{{ snapshot.retainedText }}</pre>
    </div>
    <p v-if="snapshot.status === 'saving'" class="text-[13px] text-theme-text-muted" role="status">Saving…</p>
    <div ref="fieldStart" tabindex="-1" class="flex flex-col gap-8">
      <SettingsSection v-for="group in snapshot.fieldGroups" :key="group.id" :title="group.label" :tone="group.tone" :help-paragraphs="group.descriptionParagraphs">
        <SettingsField v-for="field in group.fields" :key="field.key" :field="field" v-bind="snapshot.fieldViews[field.key]" :on-browse="onBrowse"
          @edit="$emit('edit',$event)" @commit="$emit('commit',$event)" />
      </SettingsSection>
    </div>
  </div>
</template>
<script setup>
import { ref } from 'vue';
import SettingsField from './SettingsField.vue';
import SettingsSection from './settings/SettingsSection.vue';
import SettingsActions from './SettingsActions.vue';
import CustomButton from './CustomButton.vue';
defineProps({ page:{type:Object, required:true}, snapshot:{type:Object, required:true}, onBrowse:Function });
defineEmits(['edit','commit','reload','retry']);
const fieldStart = ref(null);
</script>
