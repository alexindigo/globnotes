<template>
  <div class="flex h-full justify-center">
    <!-- Center-anchored hero: the input's top edge pins at page-center minus
         --switcher-lift — the same formula the search modal runs. The logo
         floats above without touching the anchor; quick access flows below
         the input in normal flow and never affects the position. -->
    <div class="absolute left-1/2 top-[calc(50%-var(--switcher-lift))] flex w-full max-w-[500px] -translate-x-1/2 flex-col items-center">
      <Logo class="absolute inset-x-0 bottom-full mb-5 flex justify-center" />
      <!-- Empty vault: search and the quick switcher are meaningless with
           zero notes — the greeting takes the hero slot instead. -->
      <SwitcherInput
        v-if="!(loaded && notes.length === 0)"
        v-model="searchTerm"
        class="mb-5 shadow-[0_0_20px] shadow-theme-shadow"
        @submit="submitSearch"
        @focus="openSwitcher"
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
        <!-- Empty vault greeting: say where notes live, offer the two ways
             to fill it (bind existing notes at the path, or create one) —
             creation only where the mode allows it. -->
        <div
          v-if="loaded && notes.length === 0"
          class="flex flex-col items-center"
        >
          <p class="mb-4 mt-8 text-center text-lg text-theme-text-muted">
            No notes yet
          </p>
          <p class="mb-6 max-w-96 text-center text-sm text-theme-text-muted">
            globnotes serves the files from your notes vault at
            <code
              class="rounded bg-theme-background-elevated px-1.5 py-0.5 text-theme-text"
              >{{ globalStore.config.notesPath }}</code
            >, which is currently empty. Point it at your existing notes{{
              globalStore.config.authType !== authTypes.readOnly
                ? ", or create your first note here"
                : ""
            }}.
          </p>
          <RouterLink
            v-if="globalStore.config.authType !== authTypes.readOnly"
            :to="{ name: 'new' }"
          >
            <CtaButton label="Create new note" />
          </RouterLink>
        </div>
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
import { publish, TOPICS } from "../bus/index.js";
import CustomButton from "../components/CustomButton.vue";
import CtaButton from "../components/CtaButton.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Logo from "../components/Logo.vue";
import { authTypes, searchSortOptions } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import SwitcherInput from "../components/SwitcherInput.vue";

const globalStore = useGlobalStore();
const loadingIndicator = ref();
const notes = ref([]);
const loaded = ref(false);
const toast = useToast();
const router = useRouter();
const searchTerm = ref("");

// Home's search box is the switcher's bare input. One early hint, then the
// modal takes over — the focus event carries the browser's native Event so
// the modal can place a thin caret exactly where the user clicked.
function openSwitcher(event) {
  publish(TOPICS.HOME_SEARCH_FOCUS, event);
}

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
      loaded.value = true;
      loadingIndicator.value.setLoaded();
    })
    .catch((error) => {
      loaded.value = true;
      loadingIndicator.value.setFailed();
      apiErrorHandler(error, toast);
    });
}

// Watch to allow for delayed config load.
watch(() => globalStore.config.hideRecentlyModified, init);
onMounted(init);
</script>
