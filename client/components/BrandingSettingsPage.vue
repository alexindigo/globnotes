<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="flex flex-col gap-4" data-branding-settings>
    <p v-if="!snapshot.writable" class="text-sm text-theme-text-muted">Read-only session: branding changes are unavailable.</p>
    <div><label for="brand-name" class="mb-1 block text-sm text-theme-text-muted">Name</label><TextInput id="brand-name" :model-value="snapshot.name" :readonly="!snapshot.writable" placeholder="globnotes" @update:model-value="value=>onEdit('name',value)" /></div>
    <div><label for="brand-accent" class="mb-1 block text-sm text-theme-text-muted">Accent color</label><div class="flex flex-wrap items-center gap-2">
      <input id="brand-accent" type="color" class="h-9 w-14 rounded border border-theme-border" :value="snapshot.accent" :disabled="!snapshot.writable" :class="{'opacity-40':snapshot.accentCleared}" @input="onEdit('accent',$event.target.value)">
      <span class="text-sm text-theme-text-muted">{{ snapshot.accentCleared ? 'theme default' : snapshot.accent }}</span>
      <CustomButton v-if="!snapshot.accentCleared" label="Clear" :disabled="!snapshot.writable" @click="onClearAccent" />
      <CustomButton v-else label="Keep a custom accent" :disabled="!snapshot.writable" @click="onEdit('accent',snapshot.accent)" />
    </div></div>
    <div v-for="slot in ['logo','icon']" :key="slot" class="flex flex-wrap items-center justify-between gap-3 border-t border-theme-border py-2">
      <div class="flex items-center gap-3"><img v-if="snapshot.files[slot].preview" :src="snapshot.files[slot].preview" class="h-8" alt=""><div><div class="capitalize text-theme-text">{{ slot }}</div><p class="text-xs text-theme-text-muted">SVG, PNG, JPG, WebP, GIF, ICO</p></div></div>
      <div class="flex flex-wrap items-center gap-2">
        <CustomButton v-if="snapshot.files[slot].picked" :icon-path="tabClose" title="Discard the chosen file" :disabled="!snapshot.writable" @click="onDiscardFile(slot)" />
        <CustomButton v-else-if="snapshot.files[slot].present && !snapshot.files[slot].removed" :icon-path="tabTrash" title="Remove the uploaded file" :disabled="!snapshot.writable" @click="onRemoveFile(slot)" />
        <CustomButton :icon-path="tabFileExport" :label="snapshot.files[slot].present ? 'Replace' : 'Upload'" :disabled="!snapshot.writable" @click="inputs[slot]?.click()" />
        <input :ref="el=>inputs[slot]=el" type="file" accept=".svg,.png,.jpg,.jpeg,.webp,.gif,.ico" class="hidden" :disabled="!snapshot.writable" @change="pick(slot,$event)">
      </div>
    </div>
    <p v-if="snapshot.busy" role="status" class="text-sm text-theme-text-muted">{{ snapshot.reviewing ? 'Reading current branding…' : 'Saving branding…' }}</p>
    <p v-if="snapshot.error" role="alert" class="text-sm text-theme-danger">{{ snapshot.error }} Your branding choices are retained.</p>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <CustomButton label="Reset" variant="danger" :disabled="!snapshot.writable || snapshot.busy || !snapshot.hasBranding" @click="onReset" />
      <div class="flex flex-wrap items-center gap-2"><CustomButton v-if="snapshot.canRetry" label="Review / Retry" :disabled="!snapshot.writable || snapshot.busy" @click="onRetry" /><CustomButton label="Cancel" @click="onCancel" /><CustomButton label="Save" variant="cta" :disabled="!snapshot.writable || snapshot.busy || !snapshot.dirty || snapshot.unknown" @click="onSave" /></div>
    </div>
  </section>
</template>
<script setup>
import { reactive } from "vue";
import { tabClose, tabFileExport, tabTrash } from "../icons.js";
import CustomButton from "./CustomButton.vue";
import TextInput from "./TextInput.vue";
const props = defineProps({ snapshot: Object, onEdit: Function, onClearAccent: Function, onPickFile: Function, onDiscardFile: Function, onRemoveFile: Function, onSave: Function, onReset: Function, onRetry: Function, onCancel: Function });
const inputs = reactive({ logo: null, icon: null });
function pick(slot,event) { const file=event.target.files?.[0]; if(file)props.onPickFile(slot,file); event.target.value=""; }
</script>
