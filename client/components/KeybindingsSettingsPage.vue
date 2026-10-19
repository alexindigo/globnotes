<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="flex min-h-0 flex-col gap-4" data-keybindings-settings>
    <div class="flex flex-col gap-2"><KeybindingPicker :layers="layers" :selected="snapshot.id" :on-select="onLayer" />
    <p class="text-[13px] text-theme-text-muted">{{ snapshot.description }}</p>
    <p v-if="snapshot.custom" class="text-[13px] text-theme-text-muted">Click a binding to remap it (press Escape to cancel). Changes are stored in this browser.</p></div>
    <div class="min-w-0 flex-1">
      <section v-for="group in snapshot.groups" :key="group.name" class="mb-8">
        <h3 class="mb-3 text-sm font-semibold text-theme-text">{{ group.name }}</h3>
        <div v-for="row in group.rows" :key="row.action" class="flex flex-wrap items-center justify-between gap-2 rounded py-1 text-theme-text" :data-command-binding="row.action">
          <span class="min-w-0 text-sm">{{ row.label }} <span v-if="row.dormant" class="text-theme-text-muted">(inactive; mapping retained)</span></span>
          <span class="flex items-center gap-1"><span v-if="row.modified" class="h-1.5 w-1.5 rounded-full bg-theme-brand" title="Modified in Custom" />
            <button v-if="snapshot.custom" type="button" class="focus-ring text-xs" :class="row.assigned ? 'rounded border border-theme-border px-1.5 py-0.5':'text-theme-text-muted'" :aria-label="`Remap ${row.label}, ${snapshot.capturing === row.action ? 'Press a key…' : `current ${row.display}`}`" :title="snapshot.capturing === row.action ? 'Press a key…' : 'Click to remap'" @click="onCapture(row.action)">{{ snapshot.capturing === row.action ? 'Press a key…' : row.display }}</button>
            <span v-else class="text-xs" :class="row.assigned ? 'rounded border border-theme-border px-1.5 py-0.5':'text-theme-text-muted'">{{ row.display }}</span>
            <CustomButton v-if="snapshot.custom && row.modified" type="button" label="Reset" variant="text" :aria-label="`Reset ${row.label}`" @click="onReset(row.action)" />
          </span>
        </div>
      </section>
    </div>
  </div>
</template>
<script setup>
import KeybindingPicker from "./KeybindingPicker.vue";
import CustomButton from "./CustomButton.vue";
defineProps({ layers: Array, snapshot: Object, onLayer: { type: Function, required: true }, onCapture: { type: Function, required: true }, onReset: { type: Function, required: true } });
</script>
