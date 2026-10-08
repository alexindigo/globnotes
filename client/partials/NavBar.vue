<template>
  <!-- No z-index on the band: the overlay backdrop (z-10) must dim it
       exactly like the body, and the drawer (z-40) still covers it.
       (The old z-20 served the sticky nav above a scrolling page — the
       scroller lives inside the page column now.) -->
  <nav
    class="flex w-full items-start justify-between bg-theme-background pt-4 align-top"
  >
    <div class="flex items-start">
      <RouterLink :to="{ name: 'home' }" v-if="!hideLogo">
        <Logo responsive></Logo>
      </RouterLink>
    </div>
    <div class="flex grow items-start justify-end">
      <!-- All Notes (browse the whole tree) -->
      <RouterLink
        :to="{
          name: 'search',
          query: {
            [params.searchTerm]: '*',
            [params.sortBy]: searchSortOptions.path,
          },
        }"
        title="All notes"
      >
        <CustomButton :iconPath="allNotesIcon" title="All notes" />
      </RouterLink>
      <!-- Search (unified jump + full-text) -->
      <CustomButton :iconPath="tabSearch" title="Search" @click="openSearch" />
      <!-- New Note -->
      <RouterLink v-if="showNewButton" :to="newNoteTarget">
        <CustomButton :iconPath="tabEdit" title="New note" />
      </RouterLink>
    </div>
  </nav>

</template>

<script setup>
import { tabSearch, tabEdit } from "../icons.js";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import CustomButton from "../components/CustomButton.vue";
import Logo from "../components/Logo.vue";
import { authTypes, params, searchSortOptions } from "../constants.js";
import { useGlobalStore } from "../globalStore.js";
import { directoryFromPath } from "../helpers.js";

const globalStore = useGlobalStore();

// The All Notes badge: a live vault count rendered from the note index, with
// the list-details glyph as fallback before the index loads (or in an empty
// vault). Key-string lookup into ICON_PATHS's number-*-small family.
const noteCount = computed(() => globalStore.noteMeta.length);
const allNotesIcon = computed(() =>
  noteCount.value >= 100
    ? "tabNumber100Small"
    : noteCount.value > 0
      ? `tabNumber${noteCount.value}Small`
      : "tabViewList",
);
const route = useRoute();

const newNoteTarget = computed(() => {
  if (route.name === "search" && route.query[params.folder]) {
    return { name: "new", query: { folder: route.query[params.folder] } };
  }
  if (route.name === "note" && route.params.path) {
    const folder = directoryFromPath(route.params.path);
    return folder ? { name: "new", query: { folder } } : { name: "new" };
  }
  return { name: "new" };
});

defineProps({
  hideLogo: Boolean,
});

const emit = defineEmits(["toggleQuickSwitcher"]);

function openSearch() {
  emit("toggleQuickSwitcher");
}

const showNewButton = computed(() => {
  return globalStore.config.authType !== authTypes.readOnly;
});

</script>
