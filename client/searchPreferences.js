import { ref } from "vue";
import { publish, TOPICS } from "./bus/index.js";

const STORAGE_KEY = "includeNested";

export const includeNested = ref(localStorage.getItem(STORAGE_KEY) !== "false");

export function setIncludeNested(value) {
  includeNested.value = value;
  localStorage.setItem(STORAGE_KEY, value);
  publish(TOPICS.SEARCH_INCLUDE_NESTED, { value });
}
