<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="flex min-h-0 flex-col gap-3 sm:flex-row" data-keybindings-settings>
    <KeybindingPicker class="shrink-0 sm:w-40" :layers="layers" :selected="snapshot.id" :on-select="onLayer" />
    <div class="min-w-0 flex-1">
      <p class="mb-2 text-xs text-theme-text-muted">{{ snapshot.description }}</p>
      <p v-if="snapshot.custom" class="mb-2 text-xs text-theme-text-muted">Click a binding to remap it (press Escape to cancel). Changes are stored in this browser.</p>
      <section v-for="group in snapshot.groups" :key="group.name" class="mb-3">
        <h3 class="mb-1 text-xs font-bold uppercase text-theme-text-very-muted">{{ group.name }}</h3>
        <div v-for="row in group.rows" :key="row.action" class="flex flex-wrap items-center justify-between gap-2 rounded py-1 text-theme-text" :data-command-binding="row.action">
          <span class="min-w-0 text-xs">{{ row.label }} <span v-if="row.dormant" class="text-theme-text-muted">(inactive; mapping retained)</span></span>
          <span class="flex items-center gap-1"><span v-if="row.modified" class="h-1.5 w-1.5 rounded-full bg-theme-brand" title="Modified in Custom" />
            <button v-if="snapshot.custom" class="rounded border border-theme-border px-1.5 py-0.5 font-mono text-xs" :title="snapshot.capturing === row.action ? 'Press a key…' : 'Click to remap'" @click="onCapture(row.action)">{{ snapshot.capturing === row.action ? 'Press a key…' : row.display }}</button>
            <span v-else class="rounded border border-theme-border px-1.5 py-0.5 font-mono text-xs">{{ row.display }}</span>
            <button v-if="snapshot.custom && row.modified" title="Reset to base binding" @click="onReset(row.action)">↺</button>
          </span>
        </div>
      </section>
    </div>
  </div>
</template>
<script setup>
import KeybindingPicker from "./KeybindingPicker.vue";
defineProps({ layers: Array, snapshot: Object, onLayer: { type: Function, required: true }, onCapture: { type: Function, required: true }, onReset: { type: Function, required: true } });
</script>
