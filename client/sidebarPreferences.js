import { ref } from "vue";
import { publish, TOPICS } from "./bus/index.js";

const EXPANDED_KEY = "expandedFolders";
const RECENT_KEY = "sidebarRecent";
const VISIBLE_KEY = "sidebarVisible";
const PINNED_KEY = "sidebarPinned";

export const expandedFolders = ref(
  new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]")),
);
export const sidebarRecent = ref(localStorage.getItem(RECENT_KEY) === "true");
export const sidebarVisible = ref(localStorage.getItem(VISIBLE_KEY) === "true");
export const sidebarPinned = ref(localStorage.getItem(PINNED_KEY) === "true");

export function setExpandedFolders(paths) {
  expandedFolders.value = new Set(paths);
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedFolders.value]));
}

export function setSidebarRecent(value) {
  sidebarRecent.value = value;
  localStorage.setItem(RECENT_KEY, value ? "true" : "false");
  publish(value ? TOPICS.SIDEPANEL_SECTION_SHOW : TOPICS.SIDEPANEL_SECTION_HIDE, {
    section: "recent",
  });
}

export function setSidebarVisible(value) {
  sidebarVisible.value = value;
  localStorage.setItem(VISIBLE_KEY, String(value));
  // Opening has never published a fact; preserve the existing close-only event.
  if (!value) publish(TOPICS.SIDEPANEL_CLOSE, {});
}

export function setSidebarPinned(value) {
  sidebarPinned.value = value;
  localStorage.setItem(PINNED_KEY, String(value));
}
