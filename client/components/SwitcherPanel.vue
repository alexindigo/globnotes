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
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-3">
              <span class="truncate text-theme-text">{{ entry.item.title }}</span>
              <span class="ml-3 shrink-0 truncate text-xs text-theme-text-very-muted">{{ entry.item.path }}</span>
            </div>
            <!-- Uniform "what matched" annotation: kind + the matched
                 candidate with its matched characters accented. -->
            <div v-if="matchKind(entry)" class="mt-0.5 truncate text-xs">
              <span class="text-theme-text-very-muted">{{ matchKind(entry) }}: </span>
              <HighlightedText
                class="text-theme-text-very-muted"
                :text="annotation(entry).text"
                :positions="annotation(entry).positions"
              />
            </div>
          </div>
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
import HighlightedText from "./HighlightedText.vue";
import { fuzzyFilter, windowAroundMatch } from "../fuzzy.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";

// The switcher shows at most this many note rows (the pinned full-search
// row is additional).
const MAX_RESULTS = 10;

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
      .map((item) => ({ item, score: 0, positions: [], matchedText: null, matchedKind: null }));
  }
  const rows = ranked.slice(0, MAX_RESULTS);
  if (showSearchRow.value) rows.push({ item: { search: true, term } });
  return rows;
});

// What matched, for the annotation line: a basename-fallback title is the
// filename (no explicit title exists), so it reads as "file".
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
