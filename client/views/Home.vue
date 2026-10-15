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
          :to="state.moreTarget"
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
              canCreateNote(globalStore.config.authType)
                ? ", or create your first note here"
                : ""
            }}.
          </p>
          <RouterLink
            v-if="canCreateNote(globalStore.config.authType)"
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
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { publish, TOPICS } from "../bus/index.js";
import CustomButton from "../components/CustomButton.vue";
import CtaButton from "../components/CtaButton.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Logo from "../components/Logo.vue";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import { canCreateNote } from "../noteCreation.js";
import { createQuickAccess, homeSearchTarget } from "../quickAccess.js";
import SwitcherInput from "../components/SwitcherInput.vue";

const globalStore = useGlobalStore();
const loadingIndicator = ref();
const toast = useToast();
const router = useRouter();
const searchTerm = ref("");
const quickAccess = createQuickAccess({ config: () => globalStore.config, toast });
const state = computed(quickAccess.snapshot);
const notes = computed(() => state.value.notes);
const loaded = computed(() => state.value.loaded);

watch(() => state.value.load, (load) => {
  if (load.status === "loaded") loadingIndicator.value.setLoaded();
  else if (load.status === "failed") loadingIndicator.value.setFailed();
});

// Home's search box is the switcher's bare input. One early hint, then the
// modal takes over — the focus event carries the browser's native Event so
// the modal can place a thin caret exactly where the user clicked.
function openSwitcher(event) {
  publish(TOPICS.HOME_SEARCH_FOCUS, event);
}

function submitSearch() {
  const target = homeSearchTarget(searchTerm.value);
  if (target) router.push(target);
}

// Watch to allow for delayed config load.
watch(() => globalStore.config.quickAccessLimit, quickAccess.init);
onMounted(quickAccess.init);
</script>
