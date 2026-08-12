<template>
  <!-- Floating open button (top-left corner of the page, when sidebar is closed) -->
  <CustomButton
    v-if="!globalStore.sidebarVisible"
    :iconPath="mdiDockLeft"
    label=""
    title="Open sidebar"
    style="cta"
    class="fixed left-4 top-4 z-30 shadow-md"
    @click="openSidebar"
  />
  <!-- Backdrop -->
  <div
    v-if="globalStore.sidebarVisible"
    class="fixed inset-0 z-30 bg-slate-950/40"
    @click="toggleSidebar"
  />
  <aside
    v-show="globalStore.sidebarVisible"
    class="fixed inset-y-0 left-0 z-40 w-64 overflow-y-auto border-r border-theme-border bg-theme-background py-2 shadow-lg"
  >
    <!-- Header -->
    <div class="mb-1 flex items-center justify-between px-2">
      <span class="text-xs font-bold uppercase text-theme-text-very-muted">
        Notes
      </span>
      <div class="flex items-center">
        <CustomButton
          :iconPath="mdilUnfoldLessVertical"
          label=""
          title="Collapse all"
          @click="collapseAll"
        />
        <CustomButton
          :iconPath="mdiClose"
          label=""
          title="Close sidebar"
          @click="toggleSidebar"
        />
      </div>
    </div>

    <!-- Tree -->
    <div
      v-for="row in visibleRows"
      :key="row.key"
      :style="{ paddingLeft: row.depth * 14 + 4 + 'px' }"
      class="truncate rounded px-1"
    >
      <!-- Folder row -->
      <button
        v-if="row.type === 'folder'"
        class="flex w-full cursor-pointer items-center rounded px-1 py-0.5 text-theme-text-muted hover:bg-theme-background-elevated"
        @click="toggleFolder(row.folder.path)"
      >
        <SvgIcon
          type="mdi"
          :path="row.expanded ? mdilChevronDown : mdilChevronRight"
          size="1em"
          class="mr-1 shrink-0"
        />
        <span class="truncate">{{ row.folder.name }}</span>
      </button>
      <!-- Note row -->
      <RouterLink
        v-else
        :to="notePath(row.note.title)"
        class="block truncate rounded px-1 py-0.5 hover:bg-theme-background-elevated"
        :class="{
          'bg-theme-background-elevated text-theme-text':
            row.note.title === activeTitle,
        }"
        >{{ row.note.name }}</RouterLink
      >
    </div>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";

import SvgIcon from "@jamescoyle/vue-icon";
import { mdiClose, mdiDockLeft } from "@mdi/js";
import {
  mdilChevronDown,
  mdilChevronRight,
  mdilUnfoldLessVertical,
} from "@mdi/light-js";
import CustomButton from "../components/CustomButton.vue";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";

const globalStore = useGlobalStore();
const route = useRoute();

// -- Tree ------------------------------------------------------------------

function buildTree(titles) {
  const root = { folders: new Map(), notes: [] };
  for (const title of titles) {
    const parts = title.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      if (!node.folders.has(segment)) {
        node.folders.set(segment, {
          name: segment,
          path: parts.slice(0, i + 1).join("/"),
          folders: new Map(),
          notes: [],
        });
      }
      node = node.folders.get(segment);
    }
    node.notes.push({ title, name: parts[parts.length - 1] });
  }
  return root;
}

const tree = computed(() => buildTree(globalStore.noteTitles || []));

// -- Expansion state --------------------------------------------------------

const expanded = ref(
  new Set(JSON.parse(localStorage.getItem("expandedFolders") || "[]")),
);

function persistExpanded() {
  localStorage.setItem(
    "expandedFolders",
    JSON.stringify([...expanded.value]),
  );
}

function toggleFolder(path) {
  if (expanded.value.has(path)) {
    expanded.value.delete(path);
  } else {
    expanded.value.add(path);
  }
  // Force reactivity for the Set
  expanded.value = new Set(expanded.value);
  persistExpanded();
}

function collapseAll() {
  expanded.value = new Set();
  persistExpanded();
}

// -- Visible rows (flattened, depth-first, folders before notes) ------------

const visibleRows = computed(() => {
  const rows = [];
  const walk = (node, depth) => {
    const folders = [...node.folders.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const folder of folders) {
      const isExpanded = expanded.value.has(folder.path);
      rows.push({
        key: "f:" + folder.path,
        type: "folder",
        folder,
        depth,
        expanded: isExpanded,
      });
      if (isExpanded) {
        walk(folder, depth + 1);
      }
    }
    const notes = [...node.notes].sort((a, b) => a.name.localeCompare(b.name));
    for (const note of notes) {
      rows.push({
        key: "n:" + note.title,
        type: "note",
        note,
        depth,
      });
    }
  };
  walk(tree.value, 0);
  return rows;
});

// -- Active note ------------------------------------------------------------

const activeTitle = computed(() =>
  route.name === "note" ? route.params.title : null,
);

// Expand the ancestors of the active note so it is visible.
watch(
  activeTitle,
  (title) => {
    if (!title) {
      return;
    }
    const parts = title.split("/");
    let changed = false;
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (!expanded.value.has(path)) {
        expanded.value.add(path);
        changed = true;
      }
    }
    if (changed) {
      expanded.value = new Set(expanded.value);
      persistExpanded();
    }
  },
  { immediate: true },
);

function toggleSidebar() {
  globalStore.sidebarVisible = false;
  localStorage.setItem("sidebarVisible", "false");
}

function openSidebar() {
  globalStore.sidebarVisible = true;
  localStorage.setItem("sidebarVisible", "true");
}
</script>
