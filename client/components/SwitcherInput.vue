<template>
  <div class="relative w-full">
    <input
      ref="input"
      v-model="term"
      type="text"
      class="w-full rounded-md border border-theme-border bg-theme-background px-4 py-3 text-theme-text focus:outline-none"
      :placeholder="placeholder"
      @keydown="keydownHandler"
      @keyup="stateChangeHandler"
      @click="stateChangeHandler"
      @focus="$emit('focus')"
      @blur="completion.hide()"
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
        class="cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated hover:text-theme-brand"
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
// term), submit (Enter), navigate (arrow-driven result movement), jump
// (Ctrl/Cmd+1–9 → result N), and search (Ctrl+Enter → full search page).
// Modal-local shortcuts, like ↑↓/Enter — not keybinding-layer actions.
import { computed, ref, watch } from "vue";
import { useToast } from "primevue/usetoast";

import { createTagCompletion, searchTermChanged } from "../tagCompletion.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  placeholder: { type: String, default: "Search…" },
});
const emit = defineEmits([
  "update:modelValue",
  "submit",
  "navigate",
  "focus",
  "jump",
  "search",
]);

const toast = useToast();
const input = ref();
const term = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

watch(term, searchTermChanged);

// Tag completion
const completion = createTagCompletion({ toast });
const tagState = computed(completion.snapshot);
const tagMatches = computed(() => tagState.value.matches);
const tagMenuItems = ref([]);
const tagMenuIndex = computed(() => tagState.value.index);
const tagMenuVisible = computed(() => tagState.value.visible);

function stateChangeHandler() {
  completion.update(term.value, input.value?.selectionStart ?? 0);
}
function tagChosen(tag) {
  term.value = completion.choose(term.value, input.value?.selectionStart ?? 0, tag);
}

function keydownHandler(event) {
  // Result shortcuts (Ctrl/Cmd family — bare digits must keep typing).
  if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) {
    emit("jump", Number(event.key));
    event.preventDefault();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    emit("search");
    event.preventDefault();
    return;
  }
  if (tagMenuVisible.value) {
    if (event.key === "ArrowDown") {
      completion.move(1);
      tagMenuItems.value[tagMenuIndex.value]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") {
      completion.move(-1);
      tagMenuItems.value[tagMenuIndex.value]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      tagChosen(tagMatches.value[tagMenuIndex.value]);
    } else if (event.key === "Escape") {
      completion.hide();
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
