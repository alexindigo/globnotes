// SPDX-License-Identifier: LGPL-3.0-only
import { computed, ref, watch } from "vue";
import { apiErrorHandler, getNotes, rewriteRefs } from "./api.js";
import { publish as publishFact, TOPICS } from "./bus/index.js";
import { params, searchSortOptions } from "./constants.js";
import { directoryFromPath } from "./helpers.js";
import { tabSearch } from "./icons.js";
import { decodeRewriteFiles, folderSearchTarget } from "./notePath.js";
import * as searchPreferences from "./searchPreferences.js";
import { subscribeVaultNotes } from "./vaultNoteInvalidation.js";
import { createOperationOwner } from "./operationOwner.js";

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
  sessionKey = () => null, canRead = () => true, canEdit = () => true,
} = {}) {
  const results = ref([]);
  const subdirMatches = ref([]);
  const rewriteFiles = ref(decodeRewriteFiles(initialRewriteFiles));
  const fixInProgress = ref(false);
  const load = ref({ status: "loading" });
  let requestTicket;
  let disposed = false;
  let resultOwner = sessionKey();
  const rewriteOwner = sessionKey();
  const { includeNested, setIncludeNested } = preferences;
  let operations;
  const guarded = deliver => ({ prepare(value) {
    const captured = { ...value };
    const current = !disposed && captured.scope === sessionKey() &&
      (!captured.ticket || captured.ticket === requestTicket) && (captured.write ? canEdit() && captured.scope === rewriteOwner : canRead());
    if (!current) void operations.release(captured.operation);
    return { value: captured };
  }, deliver });
  operations = createOperationOwner({ owner: Object.freeze({}),
    prepare(intent) {
      const captured = { ...intent, file: intent.file && { oldPath: intent.file.oldPath, newPath: intent.file.newPath } };
      if (disposed || captured.scope !== sessionKey() || (captured.kind === "rewrite" ? !canEdit() || captured.scope !== rewriteOwner : !canRead())) void operations.release(captured.operation);
      return { value: captured };
    },
    async dispatch(intent) {
      if (intent.kind === "rewrite") return rewrite(intent.file.oldPath, intent.file.newPath);
      const load = nested => Promise.resolve().then(() => loadNotes(intent.term, undefined, undefined, undefined, nested, intent.folder));
      const [direct, nested] = await Promise.allSettled([load(intent.nested), intent.nested ? [] : load(true)]);
      if (direct.status === "rejected") throw direct.reason;
      return [direct.value, intent.nested || nested.status === "rejected" ? [] : nested.value.map(result => result.title)];
    },
    channels: {
      results: guarded(value => {
        resultOwner = value.scope; subdirMatches.value = value.subdirs; results.value = sortResults(value.data);
        load.value = results.value.length || currentSubdirs.value.length ? { status: "loaded" } : { status: "failed", message: "No Results", icon: tabSearch };
      }),
      failed: guarded(value => { load.value = { status: "failed" }; reportError(value.error, toast); }),
      rewritten: guarded(value => publish(TOPICS.NOTE_REFS_REWRITTEN, { oldPath: value.file.oldPath, newPath: value.file.newPath })),
      row: guarded(value => { rewriteFiles.value = rewriteFiles.value.filter(file => file.oldPath !== value.file.oldPath); }),
    },
  });

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
    if (disposed || !canRead()) return;
    const ticket = {};
    const scope = sessionKey(), operation = operations.operation();
    requestTicket = ticket;
    const isCurrent = () => requestTicket === ticket && scope === sessionKey() && canRead();
    load.value = { status: "loading" };
    const { searchTerm, folder } = query();
    try {
      const { value: [data, subdirs] } = await operations.dispatch(operation, { kind: "read", term: searchTerm, nested: includeNested.value, folder, operation, scope });
      if (!isCurrent()) return;
      operations.deliver(operation, "results", { operation, ticket, scope, data, subdirs });
    } catch (error) {
      if (!isCurrent()) return;
      operations.deliver(operation, "failed", { operation, ticket, scope, error });
    } finally { await operations.release(operation); }
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

  async function rewriteFile(file, scope) {
    if (!canEdit() || scope !== sessionKey() || scope !== rewriteOwner) throw new Error("Editing is not available in this session.");
    const operation = operations.operation("retained");
    try {
      await operations.dispatch(operation, { kind: "rewrite", file, operation, scope });
      const payload = { operation, scope, write: true, file };
      operations.deliver(operation, "rewritten", payload);
      operations.deliver(operation, "row", payload);
    } finally { await operations.release(operation); }
  }

  async function fixSingleRef(file) {
    const scope = sessionKey();
    fixInProgress.value = true;
    try {
      await rewriteFile(file, scope);
      if (scope !== sessionKey()) return;
      toast.add({ severity: "success", summary: "Fixed", detail: file.oldPath, life: 3000 });
    } catch (error) {
      if (scope === sessionKey()) reportError(error, toast);
    } finally {
      fixInProgress.value = false;
    }
  }

  async function fixAllRefs() {
    const scope = sessionKey();
    fixInProgress.value = true;
    const files = [...rewriteFiles.value];
    let fixed = 0;
    try {
      for (const file of files) {
        if (scope !== sessionKey()) return;
        try {
          await rewriteFile(file, scope);
          fixed++;
        } catch (error) {
          if (scope === sessionKey()) reportError(error, toast);
        }
      }
      if (scope !== sessionKey()) return;
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
      results: resultOwner === sessionKey() && canRead() ? results.value : [],
      currentSubdirs: resultOwner === sessionKey() && canRead() ? currentSubdirs.value : [],
      upTarget: folderTarget(directoryFromPath(query().folder) || undefined),
      effectiveSortBy: effectiveSortBy.value, sortByName: sortByName.value,
      includeNested: includeNested.value, load: load.value,
      rewriteFiles: rewriteOwner === sessionKey() ? rewriteFiles.value : [], fixInProgress: fixInProgress.value,
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
    releaseVault();
    stopSession();
    return operations.dispose();
  }
  const stopSession = watch(sessionKey, () => {
    requestTicket = undefined; results.value = []; subdirMatches.value = [];
    if (!disposed && canRead()) void init();
  }, { flush: "sync" });
  const releaseVault = subscribeVaultNotes(init);
  return { snapshot, init, toggleNested, reSortResults, folderTarget, title,
    selectSort, menuItems, fixSingleRef, fixAllRefs, dispose };
}
