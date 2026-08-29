// Quick switcher — fuzzy-jump to a note by display title, alias, or path.
// Empty query shows this session's recently-opened notes (bus-fed).
<template>
  <Modal v-model="isVisible" name="switcher" class="border-none">
    <div class="p-3">
      <input
        ref="input"
        v-model="query"
        v-focus
        type="text"
        placeholder="Switch to note…"
        class="w-full rounded-md border border-theme-border bg-theme-background px-4 py-3 text-theme-text focus:outline-none"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="openSelected"
      />
      <ul class="mt-2 max-h-80 overflow-y-auto">
        <li
          v-for="(entry, i) in results"
          :key="entry.item.path"
          class="flex cursor-pointer items-center justify-between rounded px-3 py-2"
          :class="{
            'bg-theme-background-elevated': i === index,
          }"
          @click="open(entry.item)"
          @mousemove="index = i"
        >
          <span class="truncate text-theme-text">{{ entry.item.title }}</span>
          <span class="ml-3 truncate text-xs text-theme-text-very-muted">{{
            entry.item.path
          }}</span>
        </li>
        <li
          v-if="!results.length"
          class="px-3 py-2 text-theme-text-muted"
        >
          No matching notes.
        </li>
      </ul>
    </div>
  </Modal>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";

import Modal from "./Modal.vue";
import { fuzzyFilter } from "../fuzzy.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";

const isVisible = defineModel({ type: Boolean });

const globalStore = useGlobalStore();
const router = useRouter();
const query = ref("");
const index = ref(0);
const input = ref();

// Candidates to match on: display title, each alias, then the path basename.
function matchText(note) {
  return [note.title, ...(note.aliases || []), basename(note.path)];
}

function basename(path) {
  return path.split("/").pop() ?? path;
}

const results = computed(() => {
  if (query.value.trim()) {
    return fuzzyFilter(query.value, globalStore.noteMeta, matchText);
  }
  // Empty query: this session's recently-opened notes, mapped onto their
  // metadata for display titles (fall back to basename for unindexed ones).
  const metaByPath = new Map(globalStore.noteMeta.map((n) => [n.path, n]));
  return globalStore.recentlyOpened
    .map((path) => metaByPath.get(path) ?? { path, title: basename(path), aliases: [] })
    .map((item) => ({ item, score: 0, positions: [] }));
});

watch(isVisible, async (visible) => {
  if (visible) {
    query.value = "";
    index.value = 0;
    await nextTick();
    input.value?.focus();
  }
});

watch(query, () => {
  index.value = 0;
});

function move(delta) {
  if (!results.value.length) return;
  index.value = (index.value + delta + results.value.length) % results.value.length;
}

function openSelected() {
  const entry = results.value[index.value];
  if (entry) open(entry.item);
}

function open(item) {
  isVisible.value = false;
  router.push(notePath(item.path));
}
</script>
