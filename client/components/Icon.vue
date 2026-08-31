<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<script setup>
import { computed } from "vue";
import { ICON_PATHS } from "../icons.js";

const props = defineProps({
  /** Icon path data (array of <path d> strings) from icons.js. */
  icon: { type: [Array, String], default: () => [] },
  size: { type: String, default: "1.25em" },
});

// Accept either the path array (imported constant) or a key string.
const paths = computed(() =>
  Array.isArray(props.icon) ? props.icon : (ICON_PATHS[props.icon] ?? []),
);
</script>
