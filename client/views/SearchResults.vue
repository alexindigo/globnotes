<template>
  <div class="flex h-full flex-col">
    <!-- Sort By + Nested toggle -->
    <div class="mb-1 flex items-center justify-between">
      <CustomButton
        :label="`Sort By: ${sortByName}`"
        :iconPath="mdiSort"
        @click="toggleSortMenu"
      />
      <Toggle
        label="Include nested folders"
        :isOn="includeNested"
        @click="toggleNested"
      />
      <PrimeMenu ref="sortMenu" :model="menuItems" :popup="true" />
    </div>

    <!-- Search Input -->
    <SearchInput :initialSearchTerm="props.searchTerm" class="mb-12" />

    <!-- Folders at this level (when not including nested) -->
    <div
      v-if="!includeNested && currentSubdirs.length"
      class="mb-4 flex flex-wrap gap-1"
    >
      <RouterLink
        v-for="dir in currentSubdirs"
        :key="dir"
        :to="{
          name: 'search',
          query: {
            [params.searchTerm]: props.searchTerm,
            [params.sortBy]: props.sortBy,
            [params.folder]: dir,
          },
        }"
      >
        <CustomButton :iconPath="mdilFolder" :label="dir.split('/').pop()" />
      </RouterLink>
    </div>

    <LoadingIndicator ref="loadingIndicator" class="flex-1">
      <!-- Search Results -->
      <div
        v-for="result in results"
        class="mb-4 cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated"
      >
        <RouterLink :to="notePath(result.title)">
          <!-- Title and Tags -->
          <div>
            <span v-html="result.titleHighlightsOrTitle" class="mr-2"></span>
            <Tag v-for="tag in result.tagMatches" :tag="tag" class="mr-1" />
          </div>
          <!-- Last Modified and Content Highlights -->
          <div>
            <span class="text-theme-text-muted">{{
              result.lastModifiedAsString
            }}</span>
            <span v-if="result.contentHighlights"> - </span>
            <span
              v-html="result.contentHighlights"
              class="text-theme-text-muted"
            ></span>
          </div>
        </RouterLink>
      </div>
    </LoadingIndicator>
  </div>
</template>

<script setup>
import { useToast } from "primevue/usetoast";
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { mdiMagnify, mdiSort } from "@mdi/js";
import { mdilFolder } from "@mdi/light-js";
import { apiErrorHandler, getNotes } from "../api.js";
import CustomButton from "../components/CustomButton.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import PrimeMenu from "../components/PrimeMenu.vue";
import Tag from "../components/Tag.vue";
import Toggle from "../components/Toggle.vue";
import { params, searchSortOptions } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import SearchInput from "../partials/SearchInput.vue";

const props = defineProps({
  searchTerm: String,
  folder: String,
  sortBy: {
    type: Number,
    default: searchSortOptions.score,
  },
});

const loadingIndicator = ref();
const results = ref([]);
const router = useRouter();
const sortMenu = ref();
const toast = useToast();

const includeNested = ref(localStorage.getItem("includeNested") !== "false");

const globalStore = useGlobalStore();

// Immediate subdirectories of the current folder (from the full title
// index, so traversal works regardless of the search term).
const currentSubdirs = computed(() => {
  const prefix = props.folder ? props.folder + "/" : "";
  const dirs = new Set();
  for (const title of globalStore.noteTitles || []) {
    if (props.folder && !title.startsWith(prefix)) {
      continue;
    }
    const rest = props.folder ? title.slice(prefix.length) : title;
    const idx = rest.indexOf("/");
    if (idx !== -1) {
      dirs.add((props.folder ? prefix : "") + rest.slice(0, idx));
    }
  }
  return [...dirs].sort();
});

function toggleNested() {
  includeNested.value = !includeNested.value;
  localStorage.setItem("includeNested", includeNested.value);
  init();
}

const sortByName = computed(() => {
  const sortOptionNames = {
    [searchSortOptions.title]: "Title",
    [searchSortOptions.lastModified]: "Last Modified",
    [searchSortOptions.score]: "Score",
  };
  return sortOptionNames[props.sortBy];
});

function init() {
  loadingIndicator.value.setLoading();
  getNotes(
    props.searchTerm,
    undefined,
    undefined,
    undefined,
    includeNested.value,
    props.folder,
  )
    .then((data) => {
      results.value = sortResults(data);
      if (results.value.length > 0) {
        loadingIndicator.value.setLoaded();
      } else {
        loadingIndicator.value.setFailed("No Results", mdiMagnify);
      }
    })
    .catch((error) => {
      loadingIndicator.value.setFailed();
      apiErrorHandler(error, toast);
    });
}

function sortResults(results) {
  if (props.sortBy === searchSortOptions.title) {
    return results.sort((a, b) => a.title.localeCompare(b.title));
  } else if (props.sortBy === searchSortOptions.lastModified) {
    return results.sort((a, b) => b.lastModified - a.lastModified);
  } else {
    return results.sort((a, b) => b.score - a.score);
  }
}

function reSortResults() {
  results.value = sortResults(results.value);
}

function updateSortByParam(sortBy) {
  router.push({
    name: "search",
    query: {
      [params.searchTerm]: props.searchTerm,
      [params.sortBy]: sortBy,
    },
  });
}

const menuItems = [
  {
    label: "Sort By: Score",
    command: () => {
      updateSortByParam(searchSortOptions.score);
    },
  },

  {
    label: "Sort By: Title",
    command: () => {
      updateSortByParam(searchSortOptions.title);
    },
  },
  {
    label: "Sort By: Last Modified",
    command: () => {
      updateSortByParam(searchSortOptions.lastModified);
    },
  },
];

function toggleSortMenu(event) {
  sortMenu.value.toggle(event);
}

watch(() => props.searchTerm, init);
watch(() => props.sortBy, reSortResults);
onMounted(init);
</script>

<style>
.match {
  @apply text-theme-brand;
}
</style>
