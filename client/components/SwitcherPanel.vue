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
import { fuzzyFilter, windowAroundMatch } from "../fuzzy.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import { isMac } from "../keybindings/keys.js";

// The switcher shows at most this many note rows (the pinned full-search
// row is additional).
const MAX_RESULTS = 9;

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
  // Weighted, kind-tagged candidates: title outranks alias outranks
  // filename outranks folder. The full path stays a candidate so
  // cross-segment queries (e.g. "recipes/soup") keep working. The
  // basename is its own candidate so notes stay findable by filename
  // even when their display title diverges from it.
  return [
    { text: note.title, weight: 1.5, kind: "title" },
    ...(note.aliases || []).map((alias) => ({
      text: alias,
      weight: 1.4,
      kind: "alias",
    })),
    { text: basename(note.path), weight: 1.3, kind: "file" },
    { text: note.path, weight: 1, kind: "path" },
  ];
}
function kind(item) {
  return item.search ? "srch:" + item.term : item.path;
}

const showSearchRow = computed(() => Boolean(query.value.trim()));
// The empty message is meaningful only after the user typed something that
// matched no notes — never on an untouched/empty query. (results holds
// note rows only; the pinned search row is its own item.)
const showEmptyMessage = computed(() => showSearchRow.value && results.value.length === 0);
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
      .map((item) => ({ item, score: 0, positions: [], matchedText: null, matchedKind: null }));
  }
  return ranked.slice(0, MAX_RESULTS);
});

// What matched — only alias/file/path get a second line; title hits
// highlight inline in the title itself. A basename-fallback title is the
// filename, so it reads as "file".
function matchKind(entry) {
  if (!entry.matchedKind) return null;
  if (entry.matchedKind === "title" && entry.item.title === basename(entry.item.path)) {
    return "file";
  }
  return entry.matchedKind;
}

// Annotation payload for a match row: the matched text (the full path for
// file/path hits, so context survives) windowed around the first match.
function annotation(entry) {
  const kind = matchKind(entry);
  if (kind === "title" || kind === "alias") {
    return windowAroundMatch(entry.matchedText, entry.positions);
  }
  const path = entry.item.path;
  if (kind === "path") {
    return windowAroundMatch(path, entry.positions);
  }
  // file: basename positions offset into the full path.
  const offset = path.length - entry.matchedText.length;
  return windowAroundMatch(
    path,
    entry.positions.map((p) => p + offset),
  );
}

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
  if (item.search) router.push({ name: "search", query: { term: item.term } });
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
  router.push({ name: "search", query: { term: query.value.trim() } });
}
const isMacPlatform = isMac();
function shortcutLabel(key) {
  return (isMacPlatform ? "\u2318" : "Ctrl+") + key;
}
</script>
