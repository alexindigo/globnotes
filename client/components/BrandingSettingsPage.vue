<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="flex min-w-0 flex-col gap-8" data-branding-settings>
    <p v-if="!snapshot.writable" class="settings-help text-theme-text-muted">Read-only session: branding changes are unavailable.</p>
    <div class="flex flex-col gap-4">
      <SettingRow id="brand-name" label="Name" :pin="snapshot.namePin" :as="!snapshot.writable || snapshot.nameReadonly ? 'value' : 'control'" form v-slot="row">
        <span v-if="!snapshot.writable || snapshot.nameReadonly" :id="row.id" :aria-labelledby="row.labelledby" :aria-describedby="row.describedby" class="settings-text">{{ snapshot.name || 'globnotes' }}</span>
        <TextInput v-else :id="row.id" variant="settings" :aria-describedby="row.describedby" :model-value="snapshot.name" placeholder="globnotes" @update:model-value="value=>onEdit('name',value)" />
      </SettingRow>
      <SettingRow id="brand-accent" label="Accent colour" :pin="snapshot.accentPin" :as="!snapshot.writable || snapshot.accentReadonly ? 'value' : 'control'" form>
        <template #default="row"><div class="flex flex-wrap items-center justify-end gap-4">
          <span v-if="!snapshot.writable || snapshot.accentReadonly" :id="row.id" :aria-labelledby="row.labelledby" :aria-describedby="row.describedby" class="settings-text">{{ snapshot.accentCleared ? 'Theme colour' : snapshot.accent }}</span>
          <input v-else :id="row.id" :aria-describedby="row.describedby" type="color" class="focus-ring h-9 w-14 rounded border border-theme-border" :value="snapshot.accent" @input="onEdit('accent',$event.target.value)">
          <CustomButton v-if="snapshot.writable && !snapshot.accentReadonly && !snapshot.accentCleared" size="settings" type="button" label="Use theme colour" variant="secondary" wrap-label @click="onClearAccent" />
          <CustomButton v-else-if="snapshot.writable && !snapshot.accentReadonly" size="settings" type="button" label="Use custom colour" variant="secondary" wrap-label @click="onEdit('accent',snapshot.accent)" />
        </div></template>
      </SettingRow>
    </div>
    <div class="flex flex-col gap-4">
      <SettingRow v-for="slot in snapshot.slots" :key="slot.id" :label="slot.label" :help="slot.help" as="value" form>
        <template #help>{{ slot.help }}</template>
        <template #default>
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <img v-if="snapshot.files[slot.id].preview" :src="snapshot.files[slot.id].preview" class="max-h-12 max-w-full object-contain" :alt="`${slot.label} preview`">
          <span v-else class="settings-help text-theme-text-muted">No custom {{ slot.label.toLowerCase() }}.</span>
          <SettingsActions v-if="snapshot.writable">
            <template v-if="snapshot.files[slot.id].picked || snapshot.files[slot.id].present && !snapshot.files[slot.id].removed" #start>
            <CustomButton v-if="snapshot.files[slot.id].picked" size="settings" type="button" label="Discard file" variant="danger" :aria-label="`Discard chosen ${slot.label}`" @click="onDiscardFile(slot.id)" />
            <CustomButton v-else-if="snapshot.files[slot.id].present && !snapshot.files[slot.id].removed" size="settings" type="button" label="Remove" variant="danger" :aria-label="`Remove ${slot.label}`" @click="onRemoveFile(slot.id)" />
            </template>
            <CustomButton size="settings" type="button" variant="secondary" :label="snapshot.files[slot.id].present ? 'Replace' : 'Upload'" :aria-label="`${snapshot.files[slot.id].present ? 'Replace' : 'Upload'} ${slot.label}`" @click="inputs[slot.id]?.click()" />
            <input :ref="el=>inputs[slot.id]=el" type="file" :accept="slot.accept" class="hidden" @change="pick(slot.id,$event)">
          </SettingsActions>
        </div>
        </template>
      </SettingRow>
    </div>
    <div v-if="snapshot.busy || snapshot.error" class="flex flex-col gap-2" data-branding-recovery>
      <p v-if="snapshot.busy" role="status" class="settings-help text-theme-text-muted">{{ snapshot.pendingText }}</p>
      <p v-if="snapshot.error" role="alert" class="settings-help text-theme-danger">{{ snapshot.error }} Your branding choices are retained.</p>
      <CustomButton v-if="snapshot.canRetry && !snapshot.busy" size="settings" type="button" label="Check current status" variant="secondary" class="self-start" @click="onReview" />
    </div>
    <SettingsActions>
      <template #start><CustomButton v-if="snapshot.canReset" size="settings" type="button" label="Reset branding…" variant="danger" wrap-label @click="onReset" /></template>
      <template #end>
        <CustomButton v-if="snapshot.canCancel" size="settings" type="button" label="Cancel changes" variant="secondary" wrap-label @click="onCancel" />
        <CustomButton v-if="snapshot.canSave" size="settings" type="button" label="Save branding" variant="cta" wrap-label @click="onSave" />
      </template>
    </SettingsActions>
  </section>
</template>
<script setup>
import { reactive } from 'vue';
import CustomButton from './CustomButton.vue';
import SettingsActions from './SettingsActions.vue';
import SettingRow from './settings/SettingRow.vue';
import TextInput from './TextInput.vue';
const props=defineProps({snapshot:Object,onEdit:Function,onClearAccent:Function,onPickFile:Function,onDiscardFile:Function,onRemoveFile:Function,onSave:Function,onReset:Function,onReview:Function,onCancel:Function});
const inputs=reactive({});
function pick(slot,event) {const file=event.target.files?.[0];if(file)props.onPickFile(slot,file);event.target.value='';}
</script>
