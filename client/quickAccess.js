// SPDX-License-Identifier: LGPL-3.0-only
import { ref } from "vue";
import { apiErrorHandler, getNotes } from "./api.js";
import { params, searchSortOptions } from "./constants.js";
import { subscribeVaultNotes } from "./vaultNoteInvalidation.js";

export function quickAccessQuery(config) {
  // Delayed config and a hidden section must not send an invalid/unused query.
  if (config.quickAccessLimit === undefined || config.quickAccessHide) return null;
  return [
    config.quickAccessTerm,
    config.quickAccessSort,
    config.quickAccessSort === "title" ? "asc" : "desc",
    // The extra row determines whether to offer Show more.
    config.quickAccessLimit + 1,
  ];
}

export function quickAccessTarget(config) {
  return { name: "search", query: {
    [params.searchTerm]: config.quickAccessTerm,
    [params.sortBy]: searchSortOptions[config.quickAccessSort],
  } };
}

export function homeSearchTarget(input) {
  const term = input.trim();
  return term ? { name: "search", query: { [params.searchTerm]: term } } : null;
}

export function createQuickAccess({ config, toast, loadNotes = getNotes, reportError = apiErrorHandler } = {}) {
  const notes = ref([]);
  const loaded = ref(false);
  const load = ref({ status: "loading" });
  let disposed = false, ticket = 0;

  async function init() {
    if (disposed) return;
    const own = ++ticket;
    const query = quickAccessQuery(config());
    if (!query) return;
    try {
      const rows = await loadNotes(...query);
      if (disposed || own !== ticket) return;
      notes.value = rows;
      loaded.value = true;
      load.value = { status: "loaded" };
    } catch (error) {
      if (disposed || own !== ticket) return;
      loaded.value = true;
      load.value = { status: "failed" };
      reportError(error, toast);
    }
  }

  function snapshot() {
    return { notes: notes.value, loaded: loaded.value, load: load.value, moreTarget: quickAccessTarget(config()) };
  }

  const release = subscribeVaultNotes(init);
  return { snapshot, init, dispose() { disposed = true; ticket++; release(); } };
}
