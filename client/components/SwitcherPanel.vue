<template>
  <div class="w-full">
    <SwitcherInput
      ref="input"
      v-model="query"
      :placeholder="placeholder"
      @submit="openSelected"
      @navigate="move"
    />
    <ul class="mt-2 max-h-80 overflow-y-auto">
      <li
        v-for="(entry, i) in results"
        :key="kind(entry.item)"
        class="flex cursor-pointer items-center justify-between rounded px-3 py-2"
        :class="{ 'bg-theme-background-elevated': i === index }"
        @click="open(entry.item)"
        @mousemove="index = i"
      >
        <template v-if="entry.item.search">
          <span class="truncate text-theme-text">Search for “{{ entry.item.term }}”…</span>
          <span class="ml-3 text-xs text-theme-text-very-muted">full search</span>
        </template>
        <template v-else>
          <span class="truncate text-theme-text">{{ entry.item.title }}</span>
          <span class="ml-3 truncate text-xs text-theme-text-very-muted">{{ entry.item.path }}</span>
        </template>
      </li>
      <li v-if="showEmptyMessage" class="px-3 py-2 text-theme-text-muted">No matching notes.</li>
    </ul>
  </div>
</template>

<script setup>
// The switcher surface shared by the navbar's search modal and the home
// page: a SwitcherInput plus fuzzy-jump results with a pinned full-search
// row. Empty query lists this session's recently-opened notes. Emits
// "opened" after routing so modal parents can close themselves.
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import SwitcherInput from "./SwitcherInput.vue";
import { fuzzyFilter } from "../fuzzy.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";

defineProps({ placeholder: { type: String, default: "Search or switch to note…" } });
const emit = defineEmits(["opened"]);

const router = useRouter();
const globalStore = useGlobalStore();
const query = ref("");
const index = ref(0);
const input = ref();

// Focus is caller-driven — the component never self-focuses (a plain render
// like Home must not grab the keyboard). Pass the original FocusEvent to
// preserve caret position across the modal handoff, or nothing for a plain
// focus.
defineExpose({ focus: (event) => input.value?.focus?.(event) });

function basename(path) {
  return path.split("/").pop() ?? path;
}
function matchText(note) {
  return [note.title, ...(note.aliases || []), basename(note.path)];
}
function kind(item) {
  return item.search ? "srch:" + item.term : item.path;
}

const showSearchRow = computed(() => Boolean(query.value.trim()));
// The empty message is meaningful only after the user typed something that
// matched nothing — never on an untouched/empty query.
const showEmptyMessage = computed(() => showSearchRow.value && results.value.length === 1);
const results = computed(() => {
  const term = query.value.trim();
  const matchQuery = term.startsWith("#") ? term.slice(1) : term;
  let ranked = [];
  if (term) {
    ranked = fuzzyFilter(matchQuery, globalStore.noteMeta, matchText);
  } else {
    const metaByPath = new Map(globalStore.noteMeta.map((n) => [n.path, n]));
    ranked = globalStore.recentlyOpened
      .map((path) => metaByPath.get(path) ?? { path, title: basename(path), aliases: [] })
      .map((item) => ({ item, score: 0, positions: [] }));
  }
  const rows = [...ranked];
  if (showSearchRow.value) rows.push({ item: { search: true, term } });
  return rows;
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
  emit("opened");
  if (item.search) router.push({ name: "search", query: { term: item.term } });
  else router.push(notePath(item.path));
}
</script>
