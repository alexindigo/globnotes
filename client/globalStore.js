import { defineStore } from "pinia";
import { ref } from "vue";

export const useGlobalStore = defineStore("global", () => {
  const config = ref({});
  const noteTitles = ref([]);

  return { config, noteTitles };
});
