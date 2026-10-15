<template>
  <div class="relative w-full">
    <!-- Input -->
    <div
      class="flex w-full rounded-md border border-theme-border bg-theme-background dark:bg-theme-background-elevated"
      :class="{ 'px-3 py-2': !large, 'px-5 py-4': large }"
    >
      <input
        type="text"
        ref="input"
        v-model="searchTerm"
        v-focus
        class="w-full bg-transparent focus:outline-none"
        :placeholder="placeholder"
        @keydown="keydownHandler"
        @keyup="stateChangeHandler"
        @click="stateChangeHandler"
        @blur="completion.hide()"
        @keydown.down.prevent
        @keydown.up.prevent
      />
      <!-- Clear to "list all" -->
      <button
        type="button"
        class="cursor-pointer text-theme-text-muted hover:bg-theme-background-elevated hover:text-theme-brand"
        title="List all notes"
        @click="clearToAll"
      >
        <Icon icon="tabClose" size="1.25em" />
      </button>
      <!-- Note: Default behaviour for up and down keys is prevented to stop cursor moving when tag menu is navigated. -->
    </div>

    <!-- Tag Menu -->
    <div
      v-if="tagMenuVisible"
      class="absolute z-10 mt-2 max-h-64 w-full overflow-scroll rounded-md border border-theme-border bg-theme-background p-1"
    >
      <p
        v-for="(tag, index) in tagMatches"
        ref="tagMenuItems"
        class="cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated hover:text-theme-brand"
        :class="{ 'bg-theme-background-elevated': index === tagMenuIndex }"
        @click="tagChosen(tag)"
        @mousedown.prevent
      >
        <!-- Note: Default behaviour for mouse down is prevented to stop focus moving to menu on click. -->
        {{ tag }}
      </p>
    </div>
  </div>
</template>

<script setup>
import Icon from "../components/Icon.vue";
import { tabClose } from "../icons.js";
import { useToast } from "primevue/usetoast";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { createTagCompletion, searchTermChanged } from "../tagCompletion.js";
import * as constants from "../constants.js";
import { getToastOptions } from "../helpers.js";

const props = defineProps({
  initialSearchTerm: { type: String, default: "" },
  large: Boolean,
  placeholder: { type: String, default: "Search..." },
});
const emit = defineEmits(["search"]);

const input = ref();
const router = useRouter();
const searchTerm = ref(props.initialSearchTerm);
const toast = useToast();
const completion = createTagCompletion({ toast, clearOnNonTag: true });
const tagState = computed(completion.snapshot);
const tagMatches = computed(() => tagState.value.matches);
const tagMenuItems = ref([]);
const tagMenuIndex = computed(() => tagState.value.index);
const tagMenuVisible = computed(() => tagState.value.visible);

function keydownHandler(event) {
  // Tag Menu Open
  if (tagMenuVisible.value) {
    if (event.key === "ArrowDown") {
      completion.move(1);
      tagMenuItems.value[tagMenuIndex.value].scrollIntoView({
        block: "nearest",
      });
    } else if (event.key === "ArrowUp") {
      completion.move(-1);
      tagMenuItems.value[tagMenuIndex.value].scrollIntoView({
        block: "nearest",
      });
    } else if (event.key === "Enter") {
      tagChosen(tagMatches.value[tagMenuIndex.value]);
    } else if (event.key === "Escape") {
      completion.hide();
      event.stopPropagation(); // Prevent the modal from closing when the tag menu is open.
    }
  }
  // Tag Menu Closed
  else if (event.key === "Enter") {
    search();
  }
}

function tagChosen(tag) {
  searchTerm.value = completion.choose(searchTerm.value, input.value.selectionStart, tag);
}

function clearToAll() {
  searchTerm.value = "*";
  search();
}

function search() {
  if (searchTerm.value) {
    router.push({
      name: "search",
      query: {
        ...router.currentRoute.value.query,
        [constants.params.searchTerm]: searchTerm.value,
      },
    });
    emit("search");
  } else {
    toast.add(getToastOptions("Please enter a search term.", "Error", "error"));
  }
}

function stateChangeHandler() {
  completion.update(searchTerm.value, input.value.selectionStart);
}

watch(
  () => props.initialSearchTerm,
  () => {
    searchTerm.value = props.initialSearchTerm;
  },
);

// The search term is global state — every change (typing, tag insert, clear)
// publishes a search:change fact.
watch(searchTerm, searchTermChanged);
</script>
