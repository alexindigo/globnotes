<template>
  <button
    type="button"
    role="switch"
    :aria-checked="isOn"
    :disabled="disabled"
    class="toggle-control focus-ring group inline-flex shrink-0 items-center rounded px-2 py-1 text-theme-text-muted enabled:hover:bg-theme-background-elevated enabled:hover:text-theme-brand disabled:cursor-not-allowed disabled:opacity-40"
  >
    <Icon
      :icon="isOn ? tabToggleRight : tabToggleLeft"
      :class="isOn ? 'text-theme-brand' : 'text-theme-text-very-muted group-hover:text-theme-brand'"
      width="auto"
      height="1em"
      viewBox="1 5 22 14"
      class="shrink-0"
    ></Icon>
    <span v-if="label" class="ml-1 min-w-0 [overflow-wrap:anywhere]">{{ label }}</span>
  </button>
</template>

<script setup>
import Icon from "../components/Icon.vue";
import { tabToggleRight, tabToggleLeft } from "../icons.js";

defineProps({
  label: String,
  isOn: Boolean,
  disabled: Boolean,
});
</script>
