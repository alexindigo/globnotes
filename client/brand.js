import { ref } from "vue";

import iconSvg from "./assets/brand/icon.svg?raw";
import { subscribe, TOPICS } from "./bus/index.js";
import { setBrandAccent } from "./themes.js";
import { readPathPrefix } from "./pathPrefix.js";

const pathPrefix = readPathPrefix();

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
const faviconDefaults = new WeakMap();

let currentBrand = null;

// Bumped on every brand application; brand-file URLs use it as a
// cache-buster so a fresh upload replaces the old file on screen.
export const brandVersion = ref(0);

/** Only hex colors may enter the bundled SVG templates: environment/stored
 * accents can bypass endpoint validation. Shared by the logo and favicon. */
export function tintBrandSvg(svg, accent) {
  return typeof accent === "string" && /^#[0-9a-fA-F]{6}$/.test(accent)
    ? svg.replaceAll("#38BDF8", accent) : svg;
}

/** Doc-title base for router.js. */
export function currentBrandName() {
  return currentBrand?.name ?? "globnotes";
}

export function applyBrandToDocument(brand) {
  currentBrand = brand ?? null;
  brandVersion.value += 1;
  const files = brand?.files ?? [];

  // No dropped favicon files: the icon chain falls back — custom icon
  // upload → custom logo upload → accent-tinted bundled glob (same
  // recolor as the navbar logo).
  let fallback = null;
  if (!files.some((file) => FAVICON_FILES.has(file))) {
    const customIcon = files.find((f) => f.startsWith("icon."));
    const customLogo = files.find((f) => f.startsWith("logo."));
    if (customIcon) {
      fallback = `${pathPrefix}/_/brand/${customIcon}?v=${brandVersion.value}`;
    } else if (customLogo) {
      fallback = `${pathPrefix}/_/brand/${customLogo}?v=${brandVersion.value}`;
    } else if (brand?.accent) {
      const tinted = tintBrandSvg(iconSvg, brand.accent);
      fallback = `data:image/svg+xml,${encodeURIComponent(tinted)}`;
    }
  }
  // Every brand is projected from the original link, not the previous brand.
  const links = `${ICON_LINKS}, link[rel="apple-touch-icon"], link[rel="mask-icon"]`;
  for (const link of document.querySelectorAll(links)) {
    if (!faviconDefaults.has(link)) faviconDefaults.set(link, {
      href: link.getAttribute("href"), sizes: link.getAttribute("sizes"), color: link.getAttribute("color"),
      file: FAVICON_MAP.find(entry => link.matches(entry.selector))?.file,
    });
    const original = faviconDefaults.get(link), iconFallback = link.matches(ICON_LINKS) ? fallback : null;
    const href = files.includes(original.file) ? `${pathPrefix}/_/brand/${original.file}?v=${brandVersion.value}` : iconFallback ?? original.href;
    const sizes = iconFallback?.startsWith("data:") ? null : original.sizes;
    const color = link.matches('link[rel="mask-icon"]') ? brand?.accent ?? original.color : original.color;
    for (const [name, value] of Object.entries({ href, sizes, color })) {
      if (value === null) link.removeAttribute(name); else link.setAttribute(name, value);
    }
  }
  // The endpoint generates the manifest from the brand config when the
  // vault has none, so this rewrite is always safe.
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.href = `${pathPrefix}/_/brand/site.webmanifest`;

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
