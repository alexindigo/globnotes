<template>
  <!-- Floating open button (top-left corner of the page, when the
       sidebar is closed). Sits exactly where this panel's close button
       lands once open (aside py-2 + header pt-2, px-4) — the toggle
       never jumps. -->
  <CustomButton
    v-if="!globalStore.sidebarVisible"
    :iconPath="tabDockLeft"
    label=""
    title="Open sidebar"
    variant="cta"
    class="fixed left-4 top-4 z-30 shadow-md print:hidden"
    @click="openSidebar"
  />
  <!-- Backdrop: overlay mode only (unpinned) -->
  <div
    v-if="globalStore.sidebarVisible && !globalStore.sidebarPinned"
    class="fixed inset-0 z-10 bg-slate-950/40"
    @click="toggleSidebar"
  />
  <aside
    v-show="globalStore.sidebarVisible"
    :class="globalStore.sidebarPinned
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
          :title="globalStore.sidebarPinned ? 'Close sidebar' : 'Close sidebar'"
          @click="toggleSidebar"
        />
        <CustomButton
          :iconPath="globalStore.sidebarPinned ? tabPinnedOff : tabPinned"
          label=""
          :title="globalStore.sidebarPinned ? 'Unpin sidebar' : 'Pin sidebar'"
          @click="togglePin"
        />
      </div>
      <div class="flex items-center">
        <CustomButton
          :iconPath="tabFold"
          label=""
          title="Collapse all"
          :disabled="!canCollapse"
          @click="collapseAll"
        />
        <CustomButton
          :iconPath="tabFilter"
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
        class="absolute top-1/2 right-4 -translate-y-1/2 cursor-pointer text-theme-text-muted hover:bg-theme-background-elevated hover:text-theme-brand"
        title="Reset filter"
        @click="filterText = ''"
      >
        <Icon icon="tabClose" size="1.25em" />
      </button>
    </div>

    <!-- Scrollable sections -->
    <div class="min-h-0 flex-1 overflow-y-auto pr-2 pl-4">
      <!-- Recent notes (toggled via the bottom-row clock) -->
      <section v-if="recentEnabled" class="mt-4">
        <p
          v-if="showSectionTitles"
          class="mb-1 text-xs font-bold uppercase text-theme-text-very-muted"
        >
          Recent
        </p>
        <RouterLink
          v-for="note in recentNotes"
          :key="note.path"
          :to="notePath(note.path)"
          :title="note.path"
          class="flex items-center truncate rounded px-1 py-0.5 hover:bg-theme-background-elevated hover:text-theme-brand"
          :class="{
            'bg-theme-background-elevated text-theme-text':
              note.path === activePath,
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
          v-if="showSectionTitles"
          class="mb-1 text-xs font-bold uppercase text-theme-text-very-muted"
        >
          Files
        </p>
      <div
        v-for="row in visibleRows"
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
            @click="toggleFolder(row.folder.path)"
          >
            <Icon
             
              :icon="row.expanded ? tabChevronDown : tabChevronRight"
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
              row.note.path === activePath,
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

    <!-- Bottom row: section toggles (clock = Recent now; more can be added) -->
    <div class="flex items-center border-t border-theme-border px-4 pt-1 pb-1">
      <CustomButton
        :iconPath="tabClock"
        label=""
        title="Recent notes"
        :class="[
          'rounded-none border-t-2',
          recentEnabled
            ? 'text-theme-brand border-theme-brand'
            : 'border-transparent',
        ]"
        @click="toggleRecent"
      />
    </div>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import Icon from "../components/Icon.vue";
import {
  tabChevronDown,
  tabChevronRight,
  tabClose,
  tabClock,
  tabDockLeft,
  tabPinned,
  tabPinnedOff,
  tabFilter,
  tabFold,
  tabMarkdown,
} from "../icons.js";
import CustomButton from "../components/CustomButton.vue";
import TextInput from "../components/TextInput.vue";
import { getNotes, getTree } from "../api.js";
import { useGlobalStore } from "../globalStore.js";
import { publish, subscribe, TOPICS } from "../bus/index.js";
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
    node.notes.push({ path: title, name: parts[parts.length - 1] });
  }
  return root;
}

const tree = computed(() => buildTree(globalStore.notePaths || []));

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
  if (folder.notes.some((note) => note.path.toLowerCase().includes(filter))) {
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
      if (filter && !note.path.toLowerCase().includes(filter)) {
        continue;
      }
      rows.push({
        key: "n:" + note.path,
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
        .map((t) => ({
          path: typeof t === "string" ? t : t.path,
          name: typeof t === "string"
            ? t.split("/").pop()
            : (t.title ?? t.path.split("/").pop()),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const note of notes) {
        rows.push({ key: "n:" + note.path, type: "note", note, depth });
      }
    };
    lazy("", 0);
  }
  return rows;
});

// -- Active note ------------------------------------------------------------

const activePath = computed(() =>
  route.name === "note" ? route.params.path : null,
);

// -- Sections: Recent + Files ------------------------------------------------
// Sections render as named groups; titles appear only when more than one
// section is visible. The clock toggle (bottom row) switches Recent on/off,
// persisted across sessions.

const recentEnabled = ref(localStorage.getItem("sidebarRecent") === "true");
const recentNotes = ref([]);

// Sections in render order. Recent shows only when its toggle is on; Files is
// the folder tree, always present.
const enabledSections = computed(() => {
  const out = [];
  if (recentEnabled.value) out.push("recent");
  out.push("files");
  return out;
});
const showSectionTitles = computed(() => enabledSections.value.length > 1);

function toggleRecent() {
  recentEnabled.value = !recentEnabled.value;
  localStorage.setItem("sidebarRecent", recentEnabled.value ? "true" : "false");
  if (recentEnabled.value) {
    publish(TOPICS.SIDEPANEL_SECTION_SHOW, { section: "recent" });
    loadRecentNotes();
  } else {
    publish(TOPICS.SIDEPANEL_SECTION_HIDE, { section: "recent" });
  }
}

async function loadRecentNotes() {
  try {
    // Sort client-side by lastModified desc (the same approach the search
    // view uses) — the API's `sort` param expects a literal name, not the
    // numeric searchSortOptions enum.
    const results = await getNotes("*", undefined, undefined, undefined);
    recentNotes.value = [...results]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, 5)
      .map((n) => ({
        path: n.path,
        name: n.path.split("/").pop(),
      }));
  } catch {
    recentNotes.value = [];
  }
}

// Tree invalidation: `levels` is a read-through cache with no TTL, so note
// changes must drop and reload the visible levels (root + expanded) —
// same event sources noteIndex.js uses. Expansion state is preserved.
function invalidateTree() {
  levels.value = {};
  loadLevel("");
  for (const path of expanded.value) {
    loadLevel(path);
  }
  if (recentEnabled.value) loadRecentNotes();
}
subscribe(TOPICS.NOTE_CREATE, invalidateTree);
subscribe(TOPICS.NOTE_RENAME, invalidateTree);
subscribe(TOPICS.NOTE_DELETE, invalidateTree);

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
      if (!(globalStore.notePaths || []).length) {
        refreshNoteIndex();
      }
      if (recentEnabled.value) loadRecentNotes();
    }
  },
  { immediate: true },
);

// Load and expand the ancestors of the active note so it is visible.
watch(
  activePath,
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
  publish(TOPICS.SIDEPANEL_CLOSE, {});
}

function openSidebar() {
  globalStore.sidebarVisible = true;
  localStorage.setItem("sidebarVisible", "true");
}

function togglePin() {
  globalStore.sidebarPinned = !globalStore.sidebarPinned;
  localStorage.setItem("sidebarPinned", String(globalStore.sidebarPinned));
}

</script>
