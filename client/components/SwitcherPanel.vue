<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <div class="flex min-h-0 w-full flex-col">
    <SwitcherInput
      ref="input"
      v-model="query"
      :placeholder="placeholder"
      @submit="openSelected"
      @navigate="move"
      @jump="jumpTo"
      @search="goToSearch"
    />
    <div class="mt-2 flex min-h-0 flex-1 flex-col">
      <ul class="switcher-results min-h-0 flex-1 overflow-y-auto">
        <!-- Every item renders through the one shared SwitcherRow template;
             the search row is just another item (as a second hand-maintained
             copy it once drifted and missed the active-pill highlight). -->
        <switcher-row
          v-for="(entry, i) in results"
          :key="kind(entry.item)"
          :title="rowTitle(entry)"
          :subtitle="rowSubtitle(entry)"
          :shortcut="shortcutLabel(String(i + 1))"
          :hint-title="'Open result ' + (i + 1)"
          :active="i === index"
          @activate="open(entry.item)"
          @point="index = i"
        >
          <template #title>
            <span v-if="matchKind(entry) === 'title'">
              <HighlightedText
                :text="annotation(entry).text"
                :positions="annotation(entry).positions"
              />
            </span>
            <template v-else>{{ entry.item.title }}</template>
          </template>
          <template #subtitle>
            <template v-if="matchKind(entry) === 'alias'">
              <span>alias: </span>
              <HighlightedText
                :text="annotation(entry).text"
                :positions="annotation(entry).positions"
              />
            </template>
            <HighlightedText
              v-else-if="matchKind(entry) && matchKind(entry) !== 'title'"
              :text="annotation(entry).text"
              :positions="annotation(entry).positions"
            />
            <template v-else>{{ entry.item.path }}</template>
          </template>
        </switcher-row>
        <li v-if="showEmptyMessage" class="px-3 py-2 text-theme-text-muted">No matching notes.</li>
        <switcher-row
          v-if="showSearchRow"
          title="Search"
          subtitle="full search"
          :shortcut="shortcutLabel('Enter')"
          hint-title="Open the full search page"
          :active="index === results.length"
          @activate="goToSearch()"
          @point="index = results.length"
        >
          <template #title>
            Search for “{{ query.trim() }}”…
          </template>
        </switcher-row>
      </ul>
    </div>
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
import SwitcherRow from "./SwitcherRow.vue";
import HighlightedText from "./HighlightedText.vue";
import {
  rankSwitcherResults,
  switcherMatchKind as matchKind,
  switcherAnnotation as annotation,
} from "../switcherRanking.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import { isMac } from "../keybindings/keys.js";
import { params } from "../constants.js";

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

function kind(item) {
  return item.search ? "srch:" + item.term : item.path;
}

const showSearchRow = computed(() => Boolean(query.value.trim()));
// The empty message is meaningful only after the user typed something that
// matched no notes — never on an untouched/empty query. (results holds
// note rows only; the pinned search row is its own item.)
const showEmptyMessage = computed(() => showSearchRow.value && results.value.length === 0);
const results = computed(() => rankSwitcherResults(
  query.value, globalStore.noteMeta, globalStore.recentlyOpened,
));

function rowTitle(entry) {
  return entry.item.title;
}
function rowSubtitle(entry) {
  return entry.item.path;
}

watch(query, () => {
  index.value = 0;
});

function move(delta) {
  if (!results.value.length) return;
  index.value = (index.value + delta + results.value.length + 1) % (results.value.length + 1);
}
function openSelected() {
  const entry = results.value[index.value];
  if (entry) open(entry.item);
}
function open(item) {
  emit("opened");
  if (item.search) router.push({ name: "search", query: { [params.searchTerm]: item.term } });
  else router.push(notePath(item.path));
}
// Ctrl/Cmd+N jumps to result N (no-op beyond the row count); Ctrl+Enter
// opens the full search page with the current query — same as the pinned
// row's action.
function jumpTo(n) {
  const entry = results.value[n - 1];
  if (entry) open(entry.item);
}
function goToSearch() {
  emit("opened");
  router.push({ name: "search", query: { [params.searchTerm]: query.value.trim() } });
}
const isMacPlatform = isMac();
function shortcutLabel(key) {
  return (isMacPlatform ? "\u2318" : "Ctrl+") + key;
}
</script>
