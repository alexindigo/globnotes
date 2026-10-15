<script setup>
import { computed, onMounted, onUnmounted } from "vue";
import { createIndexStatus } from "../indexStatus.js";

const controller = createIndexStatus();
const state = computed(controller.snapshot);
onMounted(controller.poll);
onUnmounted(controller.dispose);
</script>

<template>
  <div
    v-if="state.syncing"
    class="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-theme-border bg-theme-background-elevated px-4 py-1.5 text-sm text-theme-text-muted shadow-md"
  >
    Indexing notes&hellip;
    <span v-if="state.total > 0" class="text-theme-text-very-muted"
      >({{ state.done }}/{{ state.total }})</span
    >
  </div>
</template>
