<template>
  <nav class="keybinding-picker flex flex-wrap overflow-hidden rounded border border-theme-border" aria-label="Keybinding layers">
    <button
      v-for="layer in layers"
      :key="layer.id"
      type="button"
      class="focus-ring px-3 py-2 text-left text-sm [--focus-ring-offset:-4px]"
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
<style scoped>
.keybinding-picker > button + button { border-inline-start:1px solid rgb(var(--theme-border)); }
</style>
