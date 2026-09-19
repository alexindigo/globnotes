<template>
  <button
    class="group flex cursor-pointer items-center text-nowrap rounded bg-theme-background px-2 py-1 text-theme-text-muted hover:bg-theme-background-elevated hover:text-theme-brand"
  >
    <span v-if="label" class="mr-2">{{ label }}</span>
    <Icon
      :icon="isOn ? tabToggleRight : tabToggleLeft"
      :class="isOn ? 'text-theme-brand' : 'text-theme-text-very-muted group-hover:text-theme-brand'"
      width="auto"
      height="1em"
      viewBox="1 5 22 14"
    ></Icon>
  </button>
</template>

<script setup>
import Icon from "../components/Icon.vue";
import { tabToggleRight, tabToggleLeft } from "../icons.js";

defineProps({
  label: String,
  isOn: Boolean,
});
</script>
