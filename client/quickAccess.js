// SPDX-License-Identifier: LGPL-3.0-only
import { ref } from "vue";
import { apiErrorHandler, getNotes } from "./api.js";
import { params, searchSortOptions } from "./constants.js";

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

  async function init() {
    const query = quickAccessQuery(config());
    if (!query) return;
    try {
      notes.value = await loadNotes(...query);
      loaded.value = true;
      load.value = { status: "loaded" };
    } catch (error) {
      loaded.value = true;
      load.value = { status: "failed" };
      reportError(error, toast);
    }
  }

  function snapshot() {
    return { notes: notes.value, loaded: loaded.value, load: load.value, moreTarget: quickAccessTarget(config()) };
  }

  return { snapshot, init };
}
