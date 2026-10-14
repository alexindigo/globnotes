<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="flex flex-col gap-1" data-appearance-settings>
    <button v-for="theme in themes" :key="theme.id" :data-theme-id="theme.id" class="flex items-center gap-2 rounded px-3 py-2 text-left text-theme-text-muted hover:bg-theme-background-elevated"
      :class="{ 'bg-theme-background-elevated text-theme-text': theme.id === selected }" :aria-pressed="theme.id === selected" @click="onSelect(theme.id)">
      <span class="h-3 w-3 shrink-0 rounded-full border border-theme-border" :style="{backgroundColor:onSwatch(theme)}" /><span>{{ theme.label }}</span>
    </button>
  </div>
</template>
<script setup>
defineProps({ themes: Array, selected: String, onSelect: { type: Function, required: true }, onSwatch: { type: Function, required: true } });
</script>
