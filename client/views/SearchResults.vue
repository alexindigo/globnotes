<template>
  <div class="flex h-full flex-col">
    <!-- Sort By + Nested toggle -->
    <div class="mb-1 flex items-center justify-between">
      <CustomButton
        :label="`Sort By: ${state.sortByName}`"
        :iconPath="tabSort"
        @click="toggleSortMenu"
      />
      <Toggle
        label="Include nested folders"
        :isOn="state.includeNested"
        @click="search.toggleNested"
      />
      <PrimeMenu
        ref="sortMenu"
        :model="search.menuItems"
        :popup="true"
        @show="publish(TOPICS.SEARCH_MENU_OPEN, {})"
        @hide="publish(TOPICS.SEARCH_MENU_CLOSE, {})"
      />
    </div>

    <!-- Search Input -->
    <SearchInput :initialSearchTerm="props.searchTerm" class="mb-12" />

    <!-- Rewrite banner (post-move scan page) -->
    <div
      v-if="state.rewriteFiles.length"
      class="mb-4 rounded-lg border border-theme-brand/20 bg-theme-background-elevated p-4"
    >
      <div class="mb-2">
        <h2 class="mb-2 text-sm font-medium text-theme-text">
          Fix broken references
        </h2>
        <CtaButton
          v-if="state.rewriteFiles.length > 1"
          label="Fix all"
          :callback="search.fixAllRefs"
        />
      </div>
      <ul class="space-y-1 text-sm">
        <li
          v-for="f in state.rewriteFiles"
          :key="f.oldPath"
          class="flex items-center justify-between rounded px-2 py-1 hover:bg-theme-background-elevated hover:text-theme-brand"
        >
          <span class="truncate text-theme-text-muted"
            ><span class="text-theme-text-very-muted">old:</span>
            {{ f.oldPath }}
            <span class="ml-2 text-theme-text-very-muted">→</span>
            <span class="ml-2">{{ f.newPath }}</span></span
          >
          <CustomButton label="Fix" style="ghost" @click="search.fixSingleRef(f)" />
        </li>
      </ul>
    </div>

    <!-- Level up (whenever inside a folder) + folders at this level (when
         not including nested) -->
    <template v-if="props.folder || (!state.includeNested && state.currentSubdirs.length)">
      <div
        v-if="props.folder"
        class="mb-4 cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated hover:text-theme-brand"
      >
        <RouterLink :to="state.upTarget" class="flex items-center">
          <Icon
           
            icon="tabArrowUp"
            size="1.25em"
            class="mr-2 text-theme-text-muted"
          />
          <span>..</span>
        </RouterLink>
      </div>
      <template v-if="!state.includeNested">
        <div
          v-for="dir in state.currentSubdirs"
          :key="dir"
          class="mb-4 cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated hover:text-theme-brand"
        >
          <RouterLink
            :to="search.folderTarget(dir)"
            class="flex items-center"
          >
            <Icon
             
              icon="tabFolder"
              size="1.25em"
              class="mr-2 text-theme-text-muted"
            />
            <span>{{ basenameOf(dir) }}</span>
          </RouterLink>
        </div>
      </template>
    </template>

    <LoadingIndicator ref="loadingIndicator" class="flex-1">
      <!-- Search Results -->
      <div
        v-for="result in state.results"
        class="mb-4 cursor-pointer rounded px-2 py-1 hover:bg-theme-background-elevated hover:text-theme-brand"
      >
        <RouterLink :to="notePath(result.path)">
          <!-- Title and Tags -->
          <div>
            <span v-html="search.title(result)" class="mr-2"></span>
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import Icon from "../components/Icon.vue";
import { tabSort } from "../icons.js";
import { publish, TOPICS } from "../bus/index.js";
import CustomButton from "../components/CustomButton.vue";
import CtaButton from "../components/CtaButton.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import PrimeMenu from "../components/PrimeMenu.vue";
import Tag from "../components/Tag.vue";
import Toggle from "../components/Toggle.vue";
import { basenameOf, notePath } from "../notePath.js";
import SearchInput from "../partials/SearchInput.vue";
import { createSearchResults } from "../searchResults.js";

const props = defineProps({
  searchTerm: String,
  folder: String,
  sortBy: {
    type: Number,
    default: undefined,
  },
});

const loadingIndicator = ref();
const route = useRoute();
const router = useRouter();
const sortMenu = ref();
const toast = useToast();
const search = createSearchResults({
  query: () => props,
  rewriteFiles: route.query.rewriteFiles,
  navigate: target => router.push(target),
  toast,
});
const state = computed(search.snapshot);

watch(() => state.value.load, load => {
  if (load.status === "loading") loadingIndicator.value.setLoading();
  else if (load.status === "loaded") loadingIndicator.value.setLoaded();
  else loadingIndicator.value.setFailed(load.message, load.icon);
}, { flush: "sync" });

function toggleSortMenu(event) {
  sortMenu.value.toggle(event);
}

watch(() => props.searchTerm, search.init);
watch(() => props.folder, search.init);
watch(() => state.value.effectiveSortBy, search.reSortResults);
onMounted(search.init);
onBeforeUnmount(search.dispose);
</script>

<style>
.match {
  @apply text-theme-brand;
}
</style>
