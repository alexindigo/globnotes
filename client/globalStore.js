import { defineStore } from "pinia";
import { ref } from "vue";

export const useGlobalStore = defineStore("global", () => {
  const config = ref({});
  const notePaths = ref([]);
  const noteMeta = ref([]);
  // Most-recently-opened note paths this session (fed by note:open on the
  // bus); the quick switcher shows it when the query is empty.
  const recentlyOpened = ref([]);
  const sidebarVisible = ref(
    localStorage.getItem("sidebarVisible") !== null
      ? localStorage.getItem("sidebarVisible") === "true"
      : false
  );
  const sidebarPinned = ref(localStorage.getItem("sidebarPinned") === "true");
  // Menu-invoked wizard: opens the setup dialog dismissibly, without
  // touching server state (the reset happens only on Finish).
  const setupWizardRequested = ref(false);

  return {
    config,
    notePaths,
    noteMeta,
    recentlyOpened,
    sidebarVisible,
    sidebarPinned,
    setupWizardRequested,
  };
});
