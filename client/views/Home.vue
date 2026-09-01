<template>
  <div class="flex h-full justify-center">
    <!-- Center-anchored hero: the input's top edge pins at page-center minus
         --switcher-lift — the same formula the search modal runs. The logo
         floats above without touching the anchor; quick access flows below
         the input in normal flow and never affects the position. -->
    <div class="absolute left-1/2 top-[calc(50%-var(--switcher-lift))] flex w-full max-w-[500px] -translate-x-1/2 flex-col items-center">
      <Logo class="absolute bottom-full left-1/2 mb-5 -translate-x-1/2" />
      <SwitcherInput
        v-model="searchTerm"
        class="mb-5 shadow-[0_0_20px] shadow-theme-shadow"
        @submit="submitSearch"
      />
      <LoadingIndicator
        ref="loadingIndicator"
        class="flex min-h-56 flex-col items-center"
        hideLoader
      >
        <p
          v-if="notes.length > 0"
          class="mb-2 text-xs font-bold uppercase text-theme-text-very-muted"
        >
          {{ globalStore.config.quickAccessTitle }}
        </p>
        <RouterLink
          v-for="note in notes.slice(0, globalStore.config.quickAccessLimit)"
          :to="notePath(note.path)"
          class="mb-1"
        >
          <CustomButton :label="note.path" />
        </RouterLink>
        <RouterLink
          v-if="notes.length > globalStore.config.quickAccessLimit"
          :to="{
            name: 'search',
            query: {
              term: globalStore.config.quickAccessTerm,
              sortBy: searchSortOptions[globalStore.config.quickAccessSort],
            },
          }"
          title="Show more"
          ><CustomButton :iconPath="tabDots"
        /></RouterLink>
      </LoadingIndicator>
    </div>
  </div>
</template>

<script setup>
import { tabDots } from "../icons.js";
import { useToast } from "primevue/usetoast";
import { onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { apiErrorHandler, getNotes } from "../api.js";
import CustomButton from "../components/CustomButton.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Logo from "../components/Logo.vue";
import { searchSortOptions } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import SwitcherInput from "../components/SwitcherInput.vue";

const globalStore = useGlobalStore();
const loadingIndicator = ref();
const notes = ref([]);
const toast = useToast();
const router = useRouter();
const searchTerm = ref("");

// Home's search box is the switcher's bare input — the full-search page is
// the only destination here.
function submitSearch() {
  const term = searchTerm.value.trim();
  if (term) router.push({ name: "search", query: { term } });
}

function init() {
  if (globalStore.config.quickAccessHide) {
    return;
  }
  getNotes(
    globalStore.config.quickAccessTerm,
    globalStore.config.quickAccessSort,
    // Order by ascending if sorting by title, descending otherwise.
    globalStore.config.quickAccessSort === "title"
      ? "asc"
      : "desc",
    // Limit is increased by 1 to check if there are more notes than the limit.
    globalStore.config.quickAccessLimit + 1,
  )
    .then((data) => {
      notes.value = data;
      loadingIndicator.value.setLoaded();
    })
    .catch((error) => {
      loadingIndicator.value.setFailed();
      apiErrorHandler(error, toast);
    });
}

// Watch to allow for delayed config load.
watch(() => globalStore.config.hideRecentlyModified, init);
onMounted(init);
</script>
