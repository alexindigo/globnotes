<template>
  <Modal v-model="isVisible" name="search" class="border-none">
    <div class="relative p-3">
      <input
        ref="input"
        v-model="query"
        v-focus
        type="text"
        class="w-full rounded-md border border-theme-border bg-theme-background px-4 py-3 text-theme-text focus:outline-none"
        placeholder="Search or switch to note…"
        @keydown="keydownHandler"
        @keyup="stateChangeHandler"
        @click="stateChangeHandler"
        @blur="tagMenuVisible = false"
        @keydown.down.prevent
        @keydown.up.prevent
      />

      <div
        v-if="tagMenuVisible"
        class="absolute z-10 mt-1 max-h-64 w-[calc(100%-1.5rem)] overflow-y-auto rounded-md border border-theme-border bg-theme-background p-1"
      >
        <p
          v-for="(tag, i) in tagMatches"
          ref="tagMenuItems"
          :key="tag"
          class="cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated"
          :class="{ 'bg-theme-background-elevated': i === tagMenuIndex }"
          @click="tagChosen(tag)"
          @mousedown.prevent
        >
          {{ tag }}
        </p>
      </div>

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
        <li v-if="!results.length && !showSearchRow" class="px-3 py-2 text-theme-text-muted">No matching notes.</li>
      </ul>
    </div>
  </Modal>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";

import Modal from "./Modal.vue";
import { apiErrorHandler, getTags } from "../api.js";
import { fuzzyFilter } from "../fuzzy.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import { useToast } from "primevue/usetoast";

const isVisible = defineModel({ type: Boolean });
const globalStore = useGlobalStore();
const router = useRouter();
const query = ref("");
const index = ref(0);
const input = ref();
const toast = useToast();

function basename(path) {
  return path.split("/").pop() ?? path;
}
function matchText(note) {
  return [note.title, ...(note.aliases || []), basename(note.path)];
}
function kind(item) {
  return item.search ? "srch:" + item.term : item.path;
}

let tags = null;
const tagMatches = ref([]);
const tagMenuItems = ref([]);
const tagMenuIndex = ref(0);
const tagMenuVisible = ref(false);

function getWordOnCursorPosition() {
  const cursorPosition = input.value?.selectionStart ?? 0;
  const wordStart = Math.max(query.value.lastIndexOf(" ", cursorPosition - 1) + 1, 0);
  let wordEnd = query.value.indexOf(" ", cursorPosition);
  if (wordEnd === -1) wordEnd = query.value.length;
  return { start: wordStart, end: wordEnd };
}
function getWordOnCursor() {
  const { start, end } = getWordOnCursorPosition();
  return query.value.substring(start, end);
}
function replaceWordOnCursor(replacement) {
  const { start, end } = getWordOnCursorPosition();
  query.value =
    query.value.substring(0, start) + replacement + query.value.substring(end);
}

async function filterTagMatches(input) {
  if (tags === null) {
    try {
      tags = await getTags();
    } catch (error) {
      tags = [];
      apiErrorHandler(error, toast);
    }
    tags = tags.map((t) => `#${t}`);
  }
  const before = tagMatches.value.length;
  tagMatches.value = tags.filter((t) => t.startsWith(input) && t !== input);
  if (before !== tagMatches.value.length && tagMatches.value.length > 0) {
    tagMenuIndex.value = 0;
    tagMenuVisible.value = true;
  } else if (tagMatches.value.length === 0) {
    tagMenuVisible.value = false;
  }
}
function stateChangeHandler() {
  const word = getWordOnCursor();
  if (word.charAt(0) !== "#") tagMenuVisible.value = false;
  else filterTagMatches(word.toLowerCase());
}
function tagChosen(tag) {
  replaceWordOnCursor(tag);
  tagMenuVisible.value = false;
}

const showSearchRow = computed(() => Boolean(query.value.trim()));
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

watch(isVisible, async (visible) => {
  if (visible) {
    query.value = "";
    index.value = 0;
    tagMenuVisible.value = false;
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
function keydownHandler(event) {
  if (tagMenuVisible.value) {
    if (event.key === "Escape") {
      tagMenuVisible.value = false;
      event.stopPropagation();
    }
    return;
  }
  if (event.key === "Enter") openSelected();
  else if (event.key === "ArrowDown" || event.key === "ArrowUp")
    move(event.key === "ArrowDown" ? 1 : -1);
}
function open(item) {
  isVisible.value = false;
  if (item.search) router.push({ name: "search", query: { term: item.term } });
  else router.push(notePath(item.path));
}
</script>
