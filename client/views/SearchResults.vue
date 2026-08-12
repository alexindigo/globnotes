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

    <!-- Level up (whenever inside a folder) + folders at this level (when
         not including nested) -->
    <template v-if="props.folder || (!includeNested && currentSubdirs.length)">
      <div
        v-if="props.folder"
        class="mb-4 cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated"
      >
        <RouterLink :to="upTarget" class="flex items-center">
          <SvgIcon
            type="mdi"
            :path="mdilArrowUp"
            size="1.25em"
            class="mr-2 text-theme-text-muted"
          />
          <span>..</span>
        </RouterLink>
      </div>
      <template v-if="!includeNested">
        <div
          v-for="dir in currentSubdirs"
          :key="dir"
          class="mb-4 cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated"
        >
          <RouterLink
            :to="{
              name: 'search',
              query: {
                [params.searchTerm]: props.searchTerm,
                [params.sortBy]: props.sortBy,
                [params.folder]: dir,
              },
            }"
            class="flex items-center"
          >
            <SvgIcon
              type="mdi"
              :path="mdilFolder"
              size="1.25em"
              class="mr-2 text-theme-text-muted"
            />
            <span>{{ dir.split("/").pop() }}</span>
          </RouterLink>
        </div>
      </template>
    </template>

    <LoadingIndicator ref="loadingIndicator" class="flex-1">
      <!-- Search Results -->
      <div
        v-for="result in results"
        class="mb-4 cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated"
      >
        <RouterLink :to="notePath(result.title)">
          <!-- Title and Tags -->
          <div>
            <span v-html="displayTitle(result)" class="mr-2"></span>
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

import SvgIcon from "@jamescoyle/vue-icon";
import { mdiMagnify, mdiSort } from "@mdi/js";
import { mdilArrowUp, mdilFolder } from "@mdi/light-js";
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
    default: undefined,
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

// One level up: the parent folder, or the unscoped search from a
// top-level folder.
const upTarget = computed(() => {
  const query = {
    [params.searchTerm]: props.searchTerm,
    [params.sortBy]: props.sortBy,
  };
  if (props.folder) {
    const parent = props.folder.split("/").slice(0, -1).join("/");
    if (parent) {
      query[params.folder] = parent;
    }
  }
  return { name: "search", query };
});

function toggleNested() {
  includeNested.value = !includeNested.value;
  localStorage.setItem("includeNested", includeNested.value);
  init();
}

// Score means nothing for a "list everything" (*) search; default to title.
const effectiveSortBy = computed(
  () =>
    props.sortBy ??
    (props.searchTerm === "*"
      ? searchSortOptions.title
      : searchSortOptions.score),
);

const sortByName = computed(() => {
  const sortOptionNames = {
    [searchSortOptions.title]: "Title",
    [searchSortOptions.lastModified]: "Last Modified",
    [searchSortOptions.score]: "Score",
  };
  return sortOptionNames[effectiveSortBy.value];
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
      } else if (!includeNested.value && currentSubdirs.value.length > 0) {
        // No direct notes, but there are subdirectories to traverse into.
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

function displayTitle(result) {
  // Show the title relative to the current folder. Highlighted titles
  // keep their markup intact (the prefix may contain match spans).
  if (result.titleHighlights) {
    return result.titleHighlights;
  }
  const prefix = props.folder ? props.folder + "/" : "";
  return prefix && result.title.startsWith(prefix)
    ? result.title.slice(prefix.length)
    : result.title;
}
function sortResults(results) {
  if (effectiveSortBy.value === searchSortOptions.title) {
    return results.sort((a, b) => a.title.localeCompare(b.title));
  } else if (effectiveSortBy.value === searchSortOptions.lastModified) {
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
watch(() => props.folder, init);
watch(effectiveSortBy, reSortResults);
onMounted(init);
</script>

<style>
.match {
  @apply text-theme-brand;
}
</style>
