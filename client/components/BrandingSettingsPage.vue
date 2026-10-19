<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="flex min-w-0 flex-col gap-8" data-branding-settings>
    <p v-if="!snapshot.writable" class="text-[13px] text-theme-text-muted">Read-only session: branding changes are unavailable.</p>
    <div class="flex flex-col gap-4">
      <SettingRow id="brand-name" label="Name" v-slot="row"><TextInput :id="row.id" :aria-describedby="row.describedby" :model-value="snapshot.name" :readonly="!snapshot.writable" placeholder="globnotes" @update:model-value="value=>onEdit('name',value)" /></SettingRow>
      <SettingRow id="brand-accent" label="Accent colour" short>
        <template #default="row"><div class="flex flex-wrap items-center justify-end gap-4">
          <input :id="row.id" type="color" class="focus-ring h-9 w-14 rounded border border-theme-border" :value="snapshot.accent" :disabled="!snapshot.writable" :class="{'opacity-40':snapshot.accentCleared}" @input="onEdit('accent',$event.target.value)">
          <CustomButton v-if="!snapshot.accentCleared" type="button" label="Use theme colour" variant="text" wrap-label :disabled="!snapshot.writable" @click="onClearAccent" />
          <CustomButton v-else type="button" label="Use custom colour" variant="text" wrap-label :disabled="!snapshot.writable" @click="onEdit('accent',snapshot.accent)" />
        </div></template>
      </SettingRow>
    </div>
    <div class="flex flex-col gap-4">
      <SettingRow v-for="slot in snapshot.slots" :key="slot.id" :label="slot.label" :help="slot.help" as="value">
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <img v-if="snapshot.files[slot.id].preview" :src="snapshot.files[slot.id].preview" class="max-h-12 max-w-full object-contain" :alt="`${slot.label} preview`">
          <span v-else class="text-[13px] text-theme-text-muted">No custom {{ slot.label.toLowerCase() }}.</span>
          <SettingsActions>
            <template v-if="snapshot.files[slot.id].picked || snapshot.files[slot.id].present && !snapshot.files[slot.id].removed" #start>
            <CustomButton v-if="snapshot.files[slot.id].picked" type="button" label="Discard file" variant="danger-text" :aria-label="`Discard chosen ${slot.label}`" :disabled="!snapshot.writable" @click="onDiscardFile(slot.id)" />
            <CustomButton v-else-if="snapshot.files[slot.id].present && !snapshot.files[slot.id].removed" type="button" label="Remove" variant="danger-text" :aria-label="`Remove ${slot.label}`" :disabled="!snapshot.writable" @click="onRemoveFile(slot.id)" />
            </template>
            <CustomButton type="button" variant="text" :label="snapshot.files[slot.id].present ? 'Replace' : 'Upload'" :aria-label="`${snapshot.files[slot.id].present ? 'Replace' : 'Upload'} ${slot.label}`" :disabled="!snapshot.writable" @click="inputs[slot.id]?.click()" />
            <input :ref="el=>inputs[slot.id]=el" type="file" :accept="slot.accept" class="hidden" :disabled="!snapshot.writable" @change="pick(slot.id,$event)">
          </SettingsActions>
        </div>
      </SettingRow>
    </div>
    <div v-if="snapshot.busy || snapshot.error" class="flex flex-col gap-2" data-branding-recovery>
      <p v-if="snapshot.busy" role="status" class="text-[13px] text-theme-text-muted">{{ snapshot.pendingText }}</p>
      <p v-if="snapshot.error" role="alert" class="text-[13px] text-theme-danger">{{ snapshot.error }} Your branding choices are retained.</p>
      <CustomButton v-if="snapshot.canRetry" type="button" label="Check current status" variant="text" class="self-start" :disabled="snapshot.busy" @click="onReview" />
    </div>
    <SettingsActions>
      <template #start><CustomButton type="button" label="Reset branding…" variant="danger-text" wrap-label :disabled="!snapshot.canReset" @click="onReset" /></template>
      <template #end>
        <CustomButton type="button" label="Cancel changes" variant="secondary" wrap-label :disabled="!snapshot.canCancel" @click="onCancel" />
        <CustomButton type="button" label="Save branding" variant="cta" wrap-label :disabled="!snapshot.canSave" @click="onSave" />
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
