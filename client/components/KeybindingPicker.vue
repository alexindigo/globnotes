<template>
  <nav class="flex flex-col gap-0.5" aria-label="Keybinding layers">
    <button
      v-for="layer in layers"
      :key="layer.id"
      type="button"
      class="w-full rounded px-2 py-1 text-left text-xs"
      :class="{
        'bg-theme-background-elevated text-theme-text':
          layer.id === selected,
        'text-theme-text-muted hover:text-theme-brand':
          layer.id !== selected,
      }"
      :title="layer.description"
      :aria-current="layer.id === selected ? 'true' : undefined"
      @click="onSelect(layer.id)"
    >
      {{ layer.label }}
    </button>
  </nav>
</template>

<script setup>
defineProps({ layers: { type: Array, required: true }, selected: { type: String, required: true }, onSelect: { type: Function, required: true } });
</script>
