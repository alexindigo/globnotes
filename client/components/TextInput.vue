<template>
  <input
    :type="type"
    class="w-full rounded-md border border-theme-border px-3 py-2 focus:outline-none dark:bg-theme-background-elevated"
    v-model="model"
    ref="input"
  />
</template>

<script setup>
import { ref } from "vue";

defineProps({
  // Opt-in input type (default text) — e.g. password fields in setup.
  type: { type: String, default: "text" },
});
const model = defineModel();
const input = ref();
</script>
