// SPDX-License-Identifier: LGPL-3.0-only
import { computed, ref } from "vue";
import { apiErrorHandler, getNotes, rewriteRefs } from "./api.js";
import { publish as publishFact, TOPICS } from "./bus/index.js";
import { params, searchSortOptions } from "./constants.js";
import { directoryFromPath } from "./helpers.js";
import { tabSearch } from "./icons.js";
import { decodeRewriteFiles, folderSearchTarget } from "./notePath.js";
import * as searchPreferences from "./searchPreferences.js";

/** Search policy and reference-rewrite work for one mounted result view. */
export function createSearchResults({
  query,
  rewriteFiles: initialRewriteFiles,
  navigate,
  toast,
  loadNotes = getNotes,
  rewrite = rewriteRefs,
  reportError = apiErrorHandler,
  publish = publishFact,
  preferences = searchPreferences,
} = {}) {
  const results = ref([]);
  const subdirMatches = ref([]);
  const rewriteFiles = ref(decodeRewriteFiles(initialRewriteFiles));
  const fixInProgress = ref(false);
  const load = ref({ status: "loading" });
  let requestTicket;
  let disposed = false;
  const { includeNested, setIncludeNested } = preferences;

  // Score means nothing for a "list everything" (*) search; default to path.
  const effectiveSortBy = computed(() => query().sortBy ??
    (query().searchTerm === "*" ? searchSortOptions.path : searchSortOptions.score));
  const sortByName = computed(() => ({
    [searchSortOptions.path]: "Path",
    [searchSortOptions.lastModified]: "Last Modified",
    [searchSortOptions.score]: "Score",
  })[effectiveSortBy.value]);

  const currentSubdirs = computed(() => {
    const folder = query().folder;
    const prefix = folder ? folder + "/" : "";
    const dirs = new Set();
    for (const path of subdirMatches.value) {
      if (folder && !path.startsWith(prefix)) continue;
      const rest = folder ? path.slice(prefix.length) : path;
      const idx = rest.indexOf("/");
      if (idx !== -1) dirs.add(prefix + rest.slice(0, idx));
    }
    return [...dirs].sort();
  });

  function folderTarget(folder) {
    return folderSearchTarget(folder, {
      [params.searchTerm]: query().searchTerm,
      [params.sortBy]: query().sortBy,
    });
  }

  function title(result) {
    if (result.pathHighlights) return result.pathHighlights;
    if (result.title) return result.title;
    const prefix = query().folder ? query().folder + "/" : "";
    return prefix && result.path.startsWith(prefix)
      ? result.path.slice(prefix.length) : result.path;
  }

  function sortResults(data) {
    if (effectiveSortBy.value === searchSortOptions.path) {
      return data.sort((a, b) => a.path.localeCompare(b.path));
    } else if (effectiveSortBy.value === searchSortOptions.lastModified) {
      return data.sort((a, b) => b.lastModified - a.lastModified);
    }
    return data.sort((a, b) => b.score - a.score);
  }

  function reSortResults() {
    results.value = sortResults(results.value);
  }

  async function init() {
    if (disposed) return;
    const ticket = {};
    requestTicket = ticket;
    const isCurrent = () => requestTicket === ticket;
    load.value = { status: "loading" };
    const { searchTerm, folder } = query();
    const resultsRequest = loadNotes(searchTerm, undefined, undefined, undefined,
      includeNested.value, folder);
    // The full nested match set supplies folders when direct notes are scoped.
    const subdirsRequest = includeNested.value ? Promise.resolve([])
      : loadNotes(searchTerm, undefined, undefined, undefined, true, folder)
        .then(data => data.map(result => result.title)).catch(() => []);
    try {
      const [data, subdirTitles] = await Promise.all([resultsRequest, subdirsRequest]);
      // Both reads belong to one search, including its loading/error surface.
      if (!isCurrent()) return;
      subdirMatches.value = subdirTitles;
      results.value = sortResults(data);
      load.value = results.value.length || currentSubdirs.value.length
        ? { status: "loaded" }
        : { status: "failed", message: "No Results", icon: tabSearch };
    } catch (error) {
      if (!isCurrent()) return;
      load.value = { status: "failed" };
      reportError(error, toast);
    }
  }

  function toggleNested() {
    if (disposed) return;
    setIncludeNested(!includeNested.value);
    return init();
  }

  function selectSort(sortBy) {
    // Preserve the existing sort-menu route (unscoped search).
    navigate({ name: "search", query: {
      [params.searchTerm]: query().searchTerm,
      [params.sortBy]: sortBy,
    } });
  }

  async function rewriteFile(file) {
    await rewrite(file.oldPath, file.newPath);
    publish(TOPICS.NOTE_REFS_REWRITTEN, {
      oldPath: file.oldPath, newPath: file.newPath,
    });
    // Single and bulk intents share acknowledgement-based row ownership.
    // A rejected rewrite leaves its row available for an explicit later retry.
    rewriteFiles.value = rewriteFiles.value.filter(f => f.oldPath !== file.oldPath);
  }

  async function fixSingleRef(file) {
    fixInProgress.value = true;
    try {
      await rewriteFile(file);
      toast.add({ severity: "success", summary: "Fixed", detail: file.oldPath, life: 3000 });
    } catch (error) {
      reportError(error, toast);
    } finally {
      fixInProgress.value = false;
    }
  }

  async function fixAllRefs() {
    fixInProgress.value = true;
    const files = [...rewriteFiles.value];
    let fixed = 0;
    try {
      for (const file of files) {
        try {
          await rewriteFile(file);
          fixed++;
        } catch (error) {
          reportError(error, toast);
        }
      }
      const failed = files.length - fixed;
      toast.add(failed
        ? { severity: fixed ? "warn" : "error",
          summary: fixed ? "Partially fixed" : "References not fixed",
          detail: `${fixed} of ${files.length} references rewritten. ${failed} failed; failed references remain listed.`, life: 3000 }
        : { severity: "success", summary: "All fixed",
          detail: `${fixed} references rewritten.`, life: 3000 });
    } finally {
      fixInProgress.value = false;
    }
  }

  function snapshot() {
    return {
      results: results.value, currentSubdirs: currentSubdirs.value,
      upTarget: folderTarget(directoryFromPath(query().folder) || undefined),
      effectiveSortBy: effectiveSortBy.value, sortByName: sortByName.value,
      includeNested: includeNested.value, load: load.value,
      rewriteFiles: rewriteFiles.value, fixInProgress: fixInProgress.value,
    };
  }

  const menuItems = [
    { label: "Sort By: Score", command: () => selectSort(searchSortOptions.score) },
    { label: "Sort By: Title", command: () => selectSort(searchSortOptions.path) },
    { label: "Sort By: Last Modified", command: () => selectSort(searchSortOptions.lastModified) },
  ];
  function dispose() {
    disposed = true;
    requestTicket = undefined;
  }
  return { snapshot, init, toggleNested, reSortResults, folderTarget, title,
    selectSort, menuItems, fixSingleRef, fixAllRefs, dispose };
}
