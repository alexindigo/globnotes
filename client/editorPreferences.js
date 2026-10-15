import { ref } from "vue";

const STORAGE_KEY = "defaultEditorMode";

export const defaultEditorMode = ref(
  localStorage.getItem(STORAGE_KEY) || "markdown",
);

export function setDefaultEditorMode(mode) {
  // Preview is a view over the buffer, not a persisted editor preference.
  if (mode === "preview") return;
  defaultEditorMode.value = mode;
  localStorage.setItem(STORAGE_KEY, mode);
}
