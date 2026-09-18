import { ref } from "vue";

import iconSvg from "./assets/brand/icon.svg?raw";
import { subscribe, TOPICS } from "./bus/index.js";
import { setBrandAccent } from "./themes.js";
import { basePath } from "./vault.js";

// favicon rel → the dropped brand file that replaces it.
const FAVICON_MAP = [
  { selector: 'link[rel="apple-touch-icon"]', file: "apple-touch-icon.png" },
  { selector: 'link[rel="icon"][sizes="32x32"]', file: "favicon-32x32.png" },
  { selector: 'link[rel="icon"][sizes="16x16"]', file: "favicon-16x16.png" },
  { selector: 'link[rel="mask-icon"]', file: "safari-pinned-tab.svg" },
  { selector: 'link[rel="shortcut icon"]', file: "favicon.ico" },
];
const FAVICON_FILES = new Set(FAVICON_MAP.map((entry) => entry.file));
// Every icon link the tab can pick (32x32 + 16x16 + shortcut).
const ICON_LINKS = 'link[rel="icon"], link[rel="shortcut icon"]';

let currentBrand = null;

// Bumped on every brand application; brand-file URLs use it as a
// cache-buster so a fresh upload replaces the old file on screen.
export const brandVersion = ref(0);

/** Doc-title base for router.js. */
export function currentBrandName() {
  return currentBrand?.name ?? "globnotes";
}

export function applyBrandToDocument(brand) {
  currentBrand = brand ?? null;
  brandVersion.value += 1;
  const files = brand?.files ?? [];

  for (const { selector, file } of FAVICON_MAP) {
    const link = document.querySelector(selector);
    if (link && files.includes(file)) {
      link.href = `${basePath()}/_/brand/${file}?v=${brandVersion.value}`;
    }
  }
  // No dropped favicon files: the icon chain falls back — custom icon
  // upload → custom logo upload → accent-tinted bundled glob (same
  // recolor as the navbar logo).
  if (!files.some((file) => FAVICON_FILES.has(file))) {
    const customIcon = files.find((f) => f.startsWith("icon."));
    const customLogo = files.find((f) => f.startsWith("logo."));
    let href = null;
    if (customIcon) {
      href = `${basePath()}/_/brand/${customIcon}?v=${brandVersion.value}`;
    } else if (customLogo) {
      href = `${basePath()}/_/brand/${customLogo}?v=${brandVersion.value}`;
    } else if (brand?.accent) {
      const tinted = iconSvg.replaceAll("#38BDF8", brand.accent);
      href = `data:image/svg+xml,${encodeURIComponent(tinted)}`;
    }
    if (href) {
      for (const link of document.querySelectorAll(ICON_LINKS)) {
        link.href = href;
        if (href.startsWith("data:")) link.removeAttribute("sizes");
      }
    }
  }
  // The endpoint generates the manifest from the brand config when the
  // vault has none, so this rewrite is always safe.
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.href = `${basePath()}/_/brand/site.webmanifest`;

  // setBrandAccent re-applies the theme, which stamps theme-color from
  // the background — set the meta afterwards so the accent wins.
  setBrandAccent(brand?.accent);
  if (brand?.accent) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = brand.accent;
  }
}

// Live re-application on branding saves — no reload.
subscribe(TOPICS.BRAND_CHANGE, (brand) => applyBrandToDocument(brand));
