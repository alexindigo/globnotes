import { publish, TOPICS } from "./bus/index.js";

const instancePrefix =
  document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

export const namespaced =
  document.querySelector('meta[name="globnotes-namespaced"]')?.content ===
    "true";

let slug = "";

export function getInstancePrefix() {
  return instancePrefix;
}

export function currentSlug() {
  return slug;
}

export function basePath() {
  if (namespaced && slug) return `${instancePrefix}/${slug}`;
  return instancePrefix;
}

const MODE_KEY = "globnotes.defaultVault";
const LAST_KEY = "globnotes.lastVault";

export function pickerMode() {
  return localStorage.getItem(MODE_KEY) || "picker";
}

export function setPickerMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

export function lastUsedSlug() {
  return localStorage.getItem(LAST_KEY) || "";
}

export function setVault(nextSlug) {
  slug = nextSlug || "";
  if (slug) localStorage.setItem(LAST_KEY, slug);
  publish(TOPICS.VAULT_CHANGE, { slug });
}
