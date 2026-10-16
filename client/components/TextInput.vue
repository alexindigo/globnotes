<template>
  <input
    :type="type"
    class="text-input w-full rounded-md border border-theme-border px-3 py-2 dark:bg-theme-background-elevated"
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

<style scoped>
.text-input:focus-visible {
  outline: 2px solid rgb(var(--theme-text));
  outline-offset: 2px;
}
</style>
