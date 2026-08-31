<template>
  <button
    class="flex cursor-pointer items-center text-nowrap rounded bg-theme-background px-2 py-1"
  >
    <span v-if="label" class="mr-2 text-theme-text-muted">{{ label }}</span>
    <Icon
      :icon="isOn ? tabToggleRight : tabToggleLeft"
      :class="{ 'text-theme-brand': isOn, 'text-theme-text-very-muted': !isOn }"
      width="auto"
      height="1em"
      viewBox="2 7 20 10"
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
