// SPDX-License-Identifier: LGPL-3.0-only
import { computed, ref } from "vue";
import { getNotes, getTree } from "./api.js";
import { subscribe as subscribeToBus, TOPICS } from "./bus/index.js";
import { useGlobalStore } from "./globalStore.js";
import { basenameOf } from "./notePath.js";
import { refreshNoteIndex } from "./noteIndex.js";
import * as sidebarPreferences from "./sidebarPreferences.js";

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
    node.notes.push({ path: title, name: basenameOf(title) });
  }
  return root;
}

function folderHasMatch(folder, filter) {
  if (folder.notes.some(note => note.path.toLowerCase().includes(filter))) return true;
  for (const sub of folder.folders.values()) {
    if (folderHasMatch(sub, filter)) return true;
  }
  return false;
}

/** Lazy browse cache and full-index filtering for one mounted sidebar. */
export function createSidebarTree({
  loadTree = getTree,
  loadNotes = getNotes,
  notePaths = () => useGlobalStore().notePaths,
  refreshIndex = refreshNoteIndex,
  preferences = sidebarPreferences,
  subscribe = subscribeToBus,
} = {}) {
  const { expandedFolders: expanded, sidebarRecent: recentEnabled,
    sidebarVisible, sidebarPinned, setExpandedFolders, setSidebarRecent,
    setSidebarVisible, setSidebarPinned } = preferences;
  const levels = ref({});
  const levelRequests = new Map();
  const filterVisible = ref(false);
  const filterText = ref("");
  const filterCollapsed = ref(new Set());
  const recentNotes = ref([]);
  const activePath = ref(null);
  const tree = computed(() => buildTree(notePaths() || []));

  async function loadLevel(path) {
    if (levels.value[path]) return;
    // Each path has its own latest request. Invalidation retires every ticket,
    // including requests started by folder toggles and active-note ancestors.
    const ticket = {};
    levelRequests.set(path, ticket);
    const isCurrent = () => levelRequests.get(path) === ticket;
    try {
      const data = await loadTree(path);
      if (!isCurrent()) return;
      levels.value = { ...levels.value, [path]: data };
    } catch (_) {
      if (!isCurrent()) return;
      levels.value = { ...levels.value, [path]: { folders: [], notes: [] } };
    } finally {
      if (isCurrent()) levelRequests.delete(path);
    }
  }

  async function toggleFolder(path) {
    if (filterText.value.trim()) {
      if (filterCollapsed.value.has(path)) filterCollapsed.value.delete(path);
      else filterCollapsed.value.add(path);
      filterCollapsed.value = new Set(filterCollapsed.value);
      return;
    }
    if (expanded.value.has(path)) expanded.value.delete(path);
    else {
      await loadLevel(path);
      expanded.value.add(path);
    }
    setExpandedFolders(expanded.value);
  }

  function collapseAll() {
    setExpandedFolders([]);
  }

  function setFilterText(text) {
    filterText.value = text;
    if (!text.trim()) filterCollapsed.value = new Set();
  }

  function toggleFilter() {
    filterVisible.value = !filterVisible.value;
    if (!filterVisible.value) {
      setFilterText("");
      filterCollapsed.value = new Set();
    }
  }

  // Depth-first, folders before notes; browse uses only fetched levels.
  const visibleRows = computed(() => {
    const rows = [];
    const filter = filterText.value.trim().toLowerCase();
    const walk = (node, depth) => {
      const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const folder of folders) {
        if (filter && !folderHasMatch(folder, filter)) continue;
        const isExpanded = filter ? !filterCollapsed.value.has(folder.path) : expanded.value.has(folder.path);
        rows.push({ key: "f:" + folder.path, type: "folder", folder, depth, expanded: isExpanded });
        if (isExpanded) walk(folder, depth + 1);
      }
      const notes = [...node.notes].sort((a, b) => a.name.localeCompare(b.name));
      for (const note of notes) {
        if (filter && !note.path.toLowerCase().includes(filter)) continue;
        rows.push({ key: "n:" + note.path, type: "note", note, depth });
      }
    };
    const lazy = (path, depth) => {
      const level = levels.value[path];
      if (!level) return;
      const folders = [...level.folders].sort((a, b) => a.name.localeCompare(b.name));
      for (const folder of folders) {
        const isExpanded = expanded.value.has(folder.path);
        rows.push({ key: "f:" + folder.path, type: "folder", folder, depth, expanded: isExpanded });
        if (isExpanded) lazy(folder.path, depth + 1);
      }
      // Filenames, never resolved display titles (including title-bearing entries).
      const notes = [...level.notes].map(t => {
        const path = typeof t === "string" ? t : t.path;
        return { path, name: basenameOf(path) };
      }).sort((a, b) => a.name.localeCompare(b.name));
      for (const note of notes) rows.push({ key: "n:" + note.path, type: "note", note, depth });
    };
    if (filter) walk(tree.value, 0);
    else lazy("", 0);
    return rows;
  });

  async function loadRecentNotes() {
    try {
      const results = await loadNotes("*", undefined, undefined, undefined);
      recentNotes.value = [...results]
        .sort((a, b) => b.lastModified - a.lastModified).slice(0, 5)
        .map(n => ({ path: n.path, name: basenameOf(n.path) }));
    } catch {
      recentNotes.value = [];
    }
  }

  function toggleRecent() {
    setSidebarRecent(!recentEnabled.value);
    if (recentEnabled.value) loadRecentNotes();
  }

  function hydrateLevels() {
    loadLevel("");
    for (const path of expanded.value) loadLevel(path);
  }

  function invalidateTree() {
    levelRequests.clear();
    levels.value = {};
    hydrateLevels();
    if (recentEnabled.value) loadRecentNotes();
  }

  subscribe(TOPICS.NOTE_CREATE, invalidateTree);
  subscribe(TOPICS.NOTE_RENAME, invalidateTree);
  subscribe(TOPICS.NOTE_DELETE, invalidateTree);

  function visibilityChanged(visible) {
    if (visible) {
      hydrateLevels();
      if (!(notePaths() || []).length) refreshIndex();
      if (recentEnabled.value) loadRecentNotes();
    }
  }

  async function setActivePath(title) {
    activePath.value = title;
    if (!title) return;
    const parts = title.split("/");
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      await loadLevel(path);
      if (!expanded.value.has(path)) expanded.value.add(path);
    }
    setExpandedFolders(expanded.value);
  }

  function snapshot() {
    return {
      sidebarVisible: sidebarVisible.value, sidebarPinned: sidebarPinned.value,
      recentEnabled: recentEnabled.value, showSectionTitles: recentEnabled.value,
      canCollapse: expanded.value.size > 0, filterVisible: filterVisible.value,
      filterText: filterText.value, recentNotes: recentNotes.value,
      activePath: activePath.value, visibleRows: visibleRows.value,
    };
  }

  return {
    snapshot, toggleFolder, collapseAll, setFilterText, toggleFilter,
    toggleRecent, visibilityChanged, setActivePath,
    closeSidebar: () => setSidebarVisible(false),
    openSidebar: () => setSidebarVisible(true),
    togglePin: () => setSidebarPinned(!sidebarPinned.value),
  };
}
