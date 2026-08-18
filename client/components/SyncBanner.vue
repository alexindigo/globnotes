<script setup>
import { onMounted, onUnmounted, ref, watch } from "vue";
import { getIndexStatus } from "../api.js";
import { refreshNoteIndex } from "../noteIndex.js";

const syncing = ref(false);
const done = ref(0);
const total = ref(0);
let timer = null;

async function poll() {
  const status = await getIndexStatus();
  syncing.value = status.syncing;
  done.value = status.done;
  total.value = status.total;
  if (status.syncing && !timer) {
    timer = setInterval(poll, 3000);
  } else if (!status.syncing && timer) {
    clearInterval(timer);
    timer = null;
  }
}

// When a sync completes, refresh the sidebar's title list.
watch(syncing, (now, before) => {
  if (before && !now) {
    refreshNoteIndex();
  }
});

onMounted(poll);
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div
    v-if="syncing"
    class="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-theme-border bg-theme-background-elevated px-4 py-1.5 text-sm text-theme-text-muted shadow-md"
  >
    Indexing notes&hellip;
    <span v-if="total > 0" class="text-theme-text-very-muted"
      >({{ done }}/{{ total }})</span
    >
  </div>
</template>
