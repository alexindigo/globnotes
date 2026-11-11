<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="flex min-h-0 flex-col gap-4" data-keybindings-settings>
    <div class="flex flex-col gap-2"><KeybindingPicker :layers="layers" :selected="snapshot.id" :on-select="onLayer" />
    <p v-if="snapshot.custom" class="max-w-[65ch] settings-help">Click a binding to remap it. Changes are stored in this browser.</p></div>
    <div class="min-w-0 flex-1">
      <section v-for="group in snapshot.groups" :key="group.name" class="mb-8">
        <h3 class="mb-3 settings-text font-semibold text-theme-text">{{ group.name }}</h3>
        <SettingRow v-for="row in group.rows" :key="row.action" :label="row.label" as="value" short class="py-1" :data-command-binding="row.action">
          <template #label="label"><span :id="label.id" :title="row.label">{{ row.label }} <span v-if="row.dormant" class="settings-small">(inactive; mapping retained)</span></span></template>
          <span class="flex items-center gap-1"><span v-if="row.modified" class="h-1.5 w-1.5 rounded-full bg-theme-brand" title="Modified in Custom" />
            <CustomButton v-if="snapshot.custom" size="settings" variant="secondary" type="button" :label="snapshot.capturing === row.action ? 'Press a key…' : row.display" :aria-label="`Remap ${row.label}, ${snapshot.capturing === row.action ? 'Press a key…' : `current ${row.display}`}`" :title="snapshot.capturing === row.action ? 'Press a key…' : 'Click to remap'" @click="onCapture(row.action)" />
            <span v-else class="settings-small" :class="row.assigned ? 'rounded border border-theme-border px-1.5 py-0.5':''">{{ row.display }}</span>
            <CustomButton size="settings" v-if="snapshot.custom && row.modified" type="button" label="Reset" variant="secondary" :aria-label="`Reset ${row.label}`" @click="onReset(row.action)" />
          </span>
        </SettingRow>
      </section>
    </div>
  </div>
</template>
<script setup>
import KeybindingPicker from "./KeybindingPicker.vue";
import CustomButton from "./CustomButton.vue";
import SettingRow from './settings/SettingRow.vue';
defineProps({ layers: Array, snapshot: Object, onLayer: { type: Function, required: true }, onCapture: { type: Function, required: true }, onReset: { type: Function, required: true } });
</script>
