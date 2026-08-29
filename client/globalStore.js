import { defineStore } from "pinia";
import { ref } from "vue";

export const useGlobalStore = defineStore("global", () => {
  const config = ref({});
  const notePaths = ref([]);
  const sidebarVisible = ref(
    localStorage.getItem("sidebarVisible") !== null
      ? localStorage.getItem("sidebarVisible") === "true"
      : window.innerWidth >= 768,
  );

  return { config, notePaths, sidebarVisible };
});
