<template>
  <div class="relative w-full">
    <input
      ref="input"
      v-model="term"
      v-focus
      type="text"
      class="w-full rounded-md border border-theme-border bg-theme-background px-4 py-3 text-theme-text focus:outline-none"
      :placeholder="placeholder"
      @keydown="keydownHandler"
      @keyup="stateChangeHandler"
      @click="stateChangeHandler"
      @blur="tagMenuVisible = false"
      @keydown.down.prevent
      @keydown.up.prevent
    />
    <div
      v-if="tagMenuVisible"
      class="absolute z-10 mt-1 w-full overflow-y-auto rounded-md border border-theme-border bg-theme-background p-1"
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
  </div>
</template>

<script setup>
// Shared search input — the bare input + tag completion used by the
// switcher panel (modal and home page). Emits: update:modelValue (live
// term), submit (Enter), and navigate (arrow-driven result movement).
import { computed, ref, watch } from "vue";
import { useToast } from "primevue/usetoast";

import { apiErrorHandler, getTags } from "../api.js";
import { publish, TOPICS } from "../bus/index.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  placeholder: { type: String, default: "Search…" },
});
const emit = defineEmits(["update:modelValue", "submit", "navigate"]);

const toast = useToast();
const input = ref();
const term = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

watch(term, (t) => publish(TOPICS.SEARCH_CHANGE, { term: t }));

// Tag completion
let tags = null;
const tagMatches = ref([]);
const tagMenuItems = ref([]);
const tagMenuIndex = ref(0);
const tagMenuVisible = ref(false);

function getWordOnCursorPosition() {
  const cursorPosition = input.value?.selectionStart ?? 0;
  const wordStart = Math.max(term.value.lastIndexOf(" ", cursorPosition - 1) + 1, 0);
  let wordEnd = term.value.indexOf(" ", cursorPosition);
  if (wordEnd === -1) wordEnd = term.value.length;
  return { start: wordStart, end: wordEnd };
}
function getWordOnCursor() {
  const { start, end } = getWordOnCursorPosition();
  return term.value.substring(start, end);
}
function replaceWordOnCursor(replacement) {
  const { start, end } = getWordOnCursorPosition();
  term.value = term.value.substring(0, start) + replacement + term.value.substring(end);
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

function keydownHandler(event) {
  if (tagMenuVisible.value) {
    if (event.key === "ArrowDown") {
      tagMenuIndex.value = Math.min(tagMenuIndex.value + 1, tagMatches.value.length - 1);
      tagMenuItems.value[tagMenuIndex.value]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") {
      tagMenuIndex.value = Math.max(tagMenuIndex.value - 1, 0);
      tagMenuItems.value[tagMenuIndex.value]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      tagChosen(tagMatches.value[tagMenuIndex.value]);
    } else if (event.key === "Escape") {
      tagMenuVisible.value = false;
      event.stopPropagation();
    }
  } else if (event.key === "Enter") {
    emit("submit");
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    emit("navigate", event.key === "ArrowDown" ? 1 : -1);
  }
}

defineExpose({ focus: () => input.value?.focus() });
</script>
