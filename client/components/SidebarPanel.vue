<template>
  <!-- Floating open button (top-left corner of the page, when the
       sidebar is closed). Sits exactly where this panel's close button
       lands once open (aside py-2 + header pt-2, px-4) — the toggle
       never jumps. -->
  <CustomButton
    v-if="!state.sidebarVisible"
    :iconPath="tabDockLeft"
    label=""
    title="Open sidebar"
    class="fixed left-4 top-4 z-30 shadow-md print:hidden"
    @click="sidebar.openSidebar"
  />
  <!-- Backdrop: overlay mode only (unpinned) -->
  <div
    v-if="state.sidebarVisible && !state.sidebarPinned"
    class="fixed inset-0 z-10 bg-slate-950/40"
    @click="sidebar.closeSidebar"
  />
  <aside
    v-show="state.sidebarVisible"
    :class="state.sidebarPinned
      ? 'fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-theme-border bg-theme-background py-2'
      : 'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-theme-border bg-theme-background py-2 shadow-lg'"
    class="flex flex-col"
  >
    <!-- Header -->
    <div class="mb-1 flex items-center justify-between px-4 pt-2">
      <!-- Sidebar behavior: close and pin belong together -->
      <div class="flex items-center">
        <CustomButton
          :iconPath="tabDockLeft"
          label=""
          :title="state.sidebarPinned ? 'Close sidebar' : 'Close sidebar'"
          @click="sidebar.closeSidebar"
        />
        <CustomButton
          :iconPath="state.sidebarPinned ? tabPinnedOff : tabPinned"
          label=""
          :title="state.sidebarPinned ? 'Unpin sidebar' : 'Pin sidebar'"
          @click="sidebar.togglePin"
        />
      </div>
      <div class="flex items-center">
        <CustomButton
          :iconPath="tabFold"
          label=""
          title="Collapse all"
          :disabled="!state.canCollapse"
          @click="sidebar.collapseAll"
        />
        <CustomButton
          :iconPath="tabFilter"
          label=""
          title="Filter"
          @click="sidebar.toggleFilter"
        />
      </div>
    </div>

    <!-- Filter input -->
    <div v-if="state.filterVisible" class="relative mb-1 px-2">
      <TextInput
        :model-value="state.filterText"
        @update:model-value="sidebar.setFilterText"
        placeholder="Filter..."
        v-focus
      />
      <button
        type="button"
        class="absolute top-1/2 right-4 -translate-y-1/2 cursor-pointer text-theme-text-muted hover:bg-theme-background-elevated hover:text-theme-brand"
        title="Reset filter"
        @click="sidebar.setFilterText('')"
      >
        <Icon icon="tabClose" size="1.25em" />
      </button>
    </div>

    <!-- Scrollable sections -->
    <div class="min-h-0 flex-1 overflow-y-auto pr-2 pl-4">
      <!-- Recent notes (toggled via the bottom-row clock) -->
      <section v-if="state.recentEnabled" class="mt-4">
        <p
          v-if="state.showSectionTitles"
          class="mb-1 text-xs font-bold uppercase text-theme-text-very-muted"
        >
          Recent
        </p>
        <RouterLink
          v-for="note in state.recentNotes"
          :key="note.path"
          :to="notePath(note.path)"
          :title="note.path"
          class="flex items-center truncate rounded px-1 py-0.5 hover:bg-theme-background-elevated hover:text-theme-brand"
          :class="{
            'bg-theme-background-elevated text-theme-text':
              note.path === state.activePath,
          }"
          ><Icon
           
            icon="tabMarkdown"
            size="1em"
            class="mr-1 shrink-0 text-theme-text-very-muted"
          /><span class="truncate">{{ note.name }}</span></RouterLink
        >
      </section>

      <!-- Files (folder tree) -->
      <section class="mt-4">
        <p
          v-if="state.showSectionTitles"
          class="mb-1 text-xs font-bold uppercase text-theme-text-very-muted"
        >
          Files
        </p>
      <div
        v-for="row in state.visibleRows"
        :key="row.key"
        :style="{ paddingLeft: row.depth * 14 + 4 + 'px' }"
        class="truncate rounded px-1"
      >
        <!-- Folder row -->
        <div
          v-if="row.type === 'folder'"
          class="group flex w-full cursor-pointer items-center rounded px-1 py-0.5 text-theme-text-muted hover:bg-theme-background-elevated hover:text-theme-brand"
        >
          <button
            class="flex min-w-0 grow items-center"
            @click="sidebar.toggleFolder(row.folder.path)"
          >
            <Icon
             
              :icon="row.expanded ? tabChevronDown : tabChevronRight"
              size="1em"
              class="mr-1 shrink-0"
            />
            <span class="truncate">{{ row.folder.name }}</span>
          </button>
          <RouterLink
            :to="folderSearchTarget(row.folder.path)"
            class="ml-1 shrink-0 opacity-0 group-hover:opacity-100"
            title="Open folder"
            @click.stop
          >
            <Icon
             
              icon="tabChevronRight"
              size="1em"
              class="text-theme-text-very-muted hover:bg-theme-background-elevated hover:text-theme-brand"
            />
          </RouterLink>
        </div>
        <!-- Note row -->
        <RouterLink
          v-else
          :to="notePath(row.note.path)"
          class="flex items-center truncate rounded px-1 py-0.5 hover:bg-theme-background-elevated hover:text-theme-brand"
          :class="{
            'bg-theme-background-elevated text-theme-text':
              row.note.path === state.activePath,
          }"
          ><Icon
           
            icon="tabMarkdown"
            size="1em"
            class="mr-1 shrink-0 text-theme-text-very-muted"
          /><span class="truncate">{{ row.note.name }}</span></RouterLink
        >
      </div>
      </section>
    </div>

    <!-- Bottom row: section toggles left, Settings gear right — one flex
         row, shared centerline by construction. -->
    <div class="flex items-center justify-between border-t border-theme-border px-4 pt-1 pb-1">
      <CustomButton
        :iconPath="tabClock"
        label=""
        title="Recent notes"
        :class="[
          'rounded-none border-t-2',
          state.recentEnabled
            ? 'text-theme-brand border-theme-brand'
            : 'border-transparent',
        ]"
        @click="sidebar.toggleRecent"
      />
      <CustomButton
        :iconPath="tabSettings"
        label=""
        title="Settings"
        aria-label="Settings"
        @click="dispatchAction(TOPICS.APP_OPEN_SETTINGS, {})"
      />
    </div>
  </aside>
</template>

<script setup>
import { computed, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import Icon from "../components/Icon.vue";
import {
  tabChevronDown,
  tabChevronRight,
  tabClose,
  tabClock,
  tabSettings,
  tabDockLeft,
  tabPinned,
  tabPinnedOff,
  tabFilter,
  tabFold,
  tabMarkdown,
} from "../icons.js";
import CustomButton from "../components/CustomButton.vue";
import TextInput from "../components/TextInput.vue";
import { TOPICS } from "../bus/index.js";
import { createSidebarTree } from "../sidebarTree.js";
import { dispatchAction } from "../keybindings/dispatcher.js";
import { folderSearchTarget, notePath } from "../notePath.js";

const route = useRoute();

const sidebar = createSidebarTree();
const state = computed(sidebar.snapshot);

watch(
  () => state.value.sidebarVisible,
  sidebar.visibilityChanged,
  { immediate: true },
);

watch(
  () => route.name === "note" ? route.params.path : null,
  sidebar.setActivePath,
  { immediate: true },
);
</script>
