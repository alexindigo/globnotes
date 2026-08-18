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
    <div class="mb-1 flex items-center justify-between px-4 pt-2">
      <CustomButton
        :iconPath="mdiDockLeft"
        label=""
        title="Close sidebar"
        @click="toggleSidebar"
      />
      <div class="flex items-center">
        <CustomButton
          :iconPath="mdilUnfoldLessVertical"
          label=""
          title="Collapse all"
          :disabled="!canCollapse"
          @click="collapseAll"
        />
        <CustomButton
          :iconPath="mdiFilterOutline"
          label=""
          title="Filter"
          @click="toggleFilter"
        />
      </div>
    </div>

    <!-- Filter input -->
    <div v-if="filterVisible" class="relative mb-1 px-2">
      <TextInput v-model="filterText" placeholder="Filter..." v-focus />
      <button
        type="button"
        class="absolute top-1/2 right-4 -translate-y-1/2 cursor-pointer text-theme-text-muted hover:text-theme-text"
        title="Reset filter"
        @click="filterText = ''"
      >
        <SvgIcon type="mdi" :path="mdiClose" size="1.25em" />
      </button>
    </div>

    <!-- Tree -->
    <div
      v-for="row in visibleRows"
      :key="row.key"
      :style="{ paddingLeft: row.depth * 14 + 4 + 'px' }"
      class="truncate rounded px-1"
    >
      <!-- Folder row -->
      <div
        v-if="row.type === 'folder'"
        class="group flex w-full cursor-pointer items-center rounded px-1 py-0.5 text-theme-text-muted hover:bg-theme-background-elevated"
      >
        <button
          class="flex min-w-0 grow items-center"
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
        <RouterLink
          :to="folderPage(row.folder.path)"
          class="ml-1 shrink-0 opacity-0 group-hover:opacity-100"
          title="Open folder"
          @click.stop
        >
          <SvgIcon
            type="mdi"
            :path="mdilChevronRight"
            size="1em"
            class="text-theme-text-very-muted hover:text-theme-text"
          />
        </RouterLink>
      </div>
      <!-- Note row -->
      <RouterLink
        v-else
        :to="notePath(row.note.title)"
        class="flex items-center truncate rounded px-1 py-0.5 hover:bg-theme-background-elevated"
        :class="{
          'bg-theme-background-elevated text-theme-text':
            row.note.title === activeTitle,
        }"
        ><SvgIcon
          type="mdi"
          :path="mdiLanguageMarkdownOutline"
          size="1em"
          class="mr-1 shrink-0 text-theme-text-very-muted"
        /><span class="truncate">{{ row.note.name }}</span></RouterLink
      >
    </div>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import SvgIcon from "@jamescoyle/vue-icon";
import { mdiClose, mdiDockLeft, mdiFilterOutline, mdiLanguageMarkdownOutline } from "@mdi/js";
import {
  mdilChevronDown,
  mdilChevronRight,
  mdilUnfoldLessVertical,
} from "@mdi/light-js";
import CustomButton from "../components/CustomButton.vue";
import TextInput from "../components/TextInput.vue";
import { getTree } from "../api.js";
import { useGlobalStore } from "../globalStore.js";
import { notePath } from "../notePath.js";
import { refreshNoteIndex } from "../noteIndex.js";
import { params } from "../constants.js";

const globalStore = useGlobalStore();
const route = useRoute();

function folderPage(path) {
  return {
    name: "search",
    query: { [params.searchTerm]: "*", [params.folder]: path },
  };
}

// -- Lazy tree --------------------------------------------------------------
// One directory level per fetch (/_/api/tree?path=...): the sidebar never
// needs the full recursive scan, and a user-expanded folder is fetched on
// demand — immediately, ahead of any background indexing.

const levels = ref({});

async function loadLevel(path) {
  if (levels.value[path]) {
    return;
  }
  try {
    const data = await getTree(path);
    levels.value = { ...levels.value, [path]: data };
  } catch (_) {
    levels.value = { ...levels.value, [path]: { folders: [], notes: [] } };
  }
}

// A tree node synthesized from a loaded level (compatible with buildTree
// nodes: name, path, folders Map, notes array).

// -- Full tree (filter mode only) -------------------------------------------

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

async function toggleFolder(path) {
  if (filterText.value.trim()) {
    // While filtering, toggle against the forced expansion.
    if (filterCollapsed.value.has(path)) {
      filterCollapsed.value.delete(path);
    } else {
      filterCollapsed.value.add(path);
    }
    // Force reactivity for the Set
    filterCollapsed.value = new Set(filterCollapsed.value);
    return;
  }
  if (expanded.value.has(path)) {
    expanded.value.delete(path);
  } else {
    // Expanding a folder fetches its children on demand — the user's
    // current folder is always front of the line.
    await loadLevel(path);
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

// Whether there is anything left to collapse.
const canCollapse = computed(() => expanded.value.size > 0);

// -- Filter -----------------------------------------------------------------

const filterVisible = ref(false);
const filterText = ref("");
// Collapse toggles made while filtering apply to the forced-expanded view
// only; the persistent expansion state is untouched.
const filterCollapsed = ref(new Set());

watch(filterText, (text) => {
  if (!text.trim()) {
    filterCollapsed.value = new Set();
  }
});

function toggleFilter() {
  filterVisible.value = !filterVisible.value;
  if (!filterVisible.value) {
    filterText.value = "";
    filterCollapsed.value = new Set();
  }
}

// A folder matches if it or any descendant has a matching note.
function folderHasMatch(folder, filter) {
  if (folder.notes.some((note) => note.title.toLowerCase().includes(filter))) {
    return true;
  }
  for (const sub of folder.folders.values()) {
    if (folderHasMatch(sub, filter)) {
      return true;
    }
  }
  return false;
}

// -- Visible rows (flattened, depth-first, folders before notes) ------------

const visibleRows = computed(() => {
  const rows = [];
  const filter = filterText.value.trim().toLowerCase();
  const walk = (node, depth) => {
    const folders = [...node.folders.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const folder of folders) {
      if (filter && !folderHasMatch(folder, filter)) {
        continue;
      }
      // Filtering forces expansion so matches are visible, minus any
      // folders collapsed during the filter.
      const isExpanded = filter
        ? !filterCollapsed.value.has(folder.path)
        : expanded.value.has(folder.path);
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
      if (filter && !note.title.toLowerCase().includes(filter)) {
        continue;
      }
      rows.push({
        key: "n:" + note.title,
        type: "note",
        note,
        depth,
      });
    }
  };
  // Browse mode walks lazily-loaded levels; filter mode needs the full tree.
  if (filter) {
    walk(tree.value, 0);
  } else {
    // Lazy walk: resolve children from on-demand loaded levels.
    const lazy = (path, depth) => {
      const level = levels.value[path];
      if (!level) {
        return;
      }
      const folders = [...level.folders].sort((a, b) =>
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
          lazy(folder.path, depth + 1);
        }
      }
      const notes = [...level.notes]
        .map((t) => ({ title: t, name: t.split("/").pop() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const note of notes) {
        rows.push({ key: "n:" + note.title, type: "note", note, depth });
      }
    };
    lazy("", 0);
  }
  return rows;
});

// -- Active note ------------------------------------------------------------

const activeTitle = computed(() =>
  route.name === "note" ? route.params.title : null,
);

// Load the root level when the drawer opens (and keep the note-index
// fresh for wiki-link resolution and the filter box). Persisted expanded
// folders are hydrated too — otherwise restored expansion shows empty
// children until the user toggles each folder.
watch(
  () => globalStore.sidebarVisible,
  (visible) => {
    if (visible) {
      loadLevel("");
      for (const path of expanded.value) {
        loadLevel(path);
      }
      if (!(globalStore.noteTitles || []).length) {
        refreshNoteIndex();
      }
    }
  },
  { immediate: true },
);

// Load and expand the ancestors of the active note so it is visible.
watch(
  activeTitle,
  async (title) => {
    if (!title) {
      return;
    }
    const parts = title.split("/");
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      await loadLevel(path);
      if (!expanded.value.has(path)) {
        expanded.value.add(path);
      }
    }
    expanded.value = new Set(expanded.value);
    persistExpanded();
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
