<template>
  <div
    ref="viewerElement"
    class="rendered-markdown"
    :class="{ 'toastui-editor-contents': loaded }"
    @click="viewerHandleAnchorClick"
  ></div>
</template>

<script>
// Same-page anchor handling for rendered markdown surfaces (this viewer and
// Note.vue's preview). A browser-native fragment click pushes a history
// entry vue-router never sees, and the next pop reinterprets the stack
// (issue #5: BACK after an anchor "enters edit mode" instead of returning
// to the origin page). Intercept: bare anchors scroll without entering
// history; app fragments stay first-class router entries; cross-page links
// are untouched.
import { parseFragment } from "../fragment.js";

export function classifyAnchorClick(href, currentHref) {
  const url = new URL(href, currentHref);
  const current = new URL(currentHref);
  if (url.pathname !== current.pathname || url.search !== current.search) {
    return "cross-page";
  }
  return parseFragment(url.hash).mode ? "app-fragment" : "same-page-anchor";
}

export async function handleAnchorClick(event) {
  const a = event.target.closest("a[href]");
  if (!a) return;
  const cls = classifyAnchorClick(a.getAttribute("href"), location.href);
  if (cls === "cross-page") return;
  event.preventDefault();
  const url = new URL(a.getAttribute("href"), location.href);
  if (cls === "app-fragment") {
    // Lazy import: a static edge to router.js would close a cycle
    // (router → views → ServerViewer → router) and shift boot init order.
    const { default: router } = await import("../router.js");
    router.push(url.pathname + url.search + url.hash);
    return;
  }
  const id = decodeURIComponent(url.hash.slice(1));
  const target = document.getElementById(id) ||
    document.querySelector(`a[name="${CSS.escape(id)}"]`);
  target?.scrollIntoView();
}
</script>

<script setup>
import { tabCheck, tabCopy } from "../icons.js";
import renderMathInElement from "katex/contrib/auto-render/auto-render.js";
import mermaid from "mermaid";
import { onMounted, ref, watch } from "vue";

import { getPlugins, getRenderedHtml } from "../api.js";
import { subscribe, TOPICS } from "../bus/index.js";
import { disabledPluginIds, viewLineNumbers } from "../pluginSettings.js";
// The plain script above owns + exports the handlers (Note.vue imports
// them); the alias self-import binds them for this surface's template
// without colliding with the export declarations.
import { handleAnchorClick as viewerHandleAnchorClick } from "./ServerViewer.vue";

const props = defineProps({
  title: String,
  // View-mode line-link fragment: { from, to } source-line range to
  // highlight after render (from the #view:L aspect).
  line: Object,
});

const viewerElement = ref();
// The container class appears only when content does — the old viewer
// rendered both atomically, and e2e/style hooks poll the class.
const loaded = ref(false);
// Tabler icons are stroke-based multi-path; render them inline for the
// dynamically-created copy buttons (no Vue component available there).
function tablerSvg(paths) {
  return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg>`;
}
const COPY_ICON = tablerSvg(tabCopy);
const CHECK_ICON = tablerSvg(tabCheck);

// Copy button on every code block (skipping mermaid sources).
function addCopyButtons(root) {
  root.querySelectorAll("pre:not(.mermaid)").forEach((pre) => {
    if (pre.querySelector(".code-copy-btn")) {
      return;
    }
    pre.style.position = "relative";
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.title = "Copy";
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", async () => {
      const text =
        pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      await navigator.clipboard.writeText(text);
      btn.innerHTML = CHECK_ICON;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove("copied");
      }, 1500);
    });
    pre.appendChild(btn);
  });
}

// Mermaid follows the app's light/dark mode: the theme engine maintains
// body.dark as the source of truth, so diagrams re-initialize per render
// with the matching built-in mermaid theme. Label spans inherit the app's
// text color, which keeps them readable once the themes agree.
// Mermaid theme palettes: map the app's live --theme-* CSS variables into
// mermaid's themeVariables so diagrams pick up every theme's palette
// instead of mermaid's two built-ins. Computed at init from the applied
// theme (the theme engine stamps the variables on <html> before render).
// Variables are stored as space-separated RGB triplets ("243 244 245");
// mermaid needs hex, so triplets convert back via rgb().
function mermaidColor(name, fallback) {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--theme-${name}`).trim();
  if (!raw) return fallback;
  if (raw.startsWith("#")) return raw;
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length === 3 && parts.every((n) => n >= 0 && n <= 255)) {
    return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return fallback;
}

function mermaidThemeVariables() {
  const v = mermaidColor;
  return {
    background: "transparent",
    primaryColor: v("background-elevated", "#ececff"),
    primaryTextColor: v("text", "#333"),
    primaryBorderColor: v("border", "#999"),
    secondaryColor: v("background", "#ffffde"),
    secondaryTextColor: v("text", "#333"),
    secondaryBorderColor: v("border", "#999"),
    tertiaryColor: v("background-elevated", "#ececff"),
    tertiaryTextColor: v("text", "#333"),
    tertiaryBorderColor: v("border", "#999"),
    noteBkgColor: v("background-elevated", "#fff5ad"),
    noteTextColor: v("text", "#333"),
    noteBorderColor: v("brand", "#999"),
    lineColor: v("text-muted", "#333"),
    textColor: v("text", "#333"),
    mainBkg: v("background-elevated", "#ececff"),
    nodeBorder: v("border", "#999"),
    clusterBkg: v("background", "#ffffde"),
    clusterBorder: v("border", "#999"),
    edgeLabelBackground: v("background-elevated", "#e8e8e8"),
    actorBkg: v("background-elevated", "#ececff"),
    actorBorder: v("border", "#999"),
    actorTextColor: v("text", "#333"),
    actorLineColor: v("text-muted", "#999"),
    signalColor: v("text", "#333"),
    signalTextColor: v("text", "#333"),
    labelBoxBkgColor: v("background-elevated", "#ececff"),
    labelBoxBorderColor: v("border", "#999"),
    labelTextColor: v("text", "#333"),
    loopTextColor: v("text", "#333"),
    activationBkgColor: v("background-elevated", "#ececff"),
    activationBorderColor: v("border", "#999"),
    sequenceNumberColor: v("background", "#fff"),
    // Gantt
    sectionBkgColor: v("background-elevated", "#ececff"),
    altSectionBkgColor: v("background", "#ffffde"),
    sectionBkgColor2: v("background-elevated", "#ececff"),
    taskBkgColor: v("brand", "#ccc"),
    taskTextColor: v("background", "#fff"),
    taskBorderColor: v("border", "#999"),
    taskTextDarkColor: v("text", "#333"),
    taskTextOutsideColor: v("text-muted", "#333"),
    taskTextClickableColor: v("brand", "#003163"),
    activeTaskBkgColor: v("brand", "#ccc"),
    activeTaskBorderColor: v("border", "#999"),
    doneTaskBkgColor: v("text-very-muted", "#bbb"),
    doneTaskBorderColor: v("text-muted", "#999"),
    critBkgColor: v("code-keyword", "#ff8888"),
    critBorderColor: v("border", "#999"),
    todayLineColor: v("brand", "#ff0000"),
    // Pie / state / class shared accents
    pie1: v("brand", "#ccc"),
    pie2: v("code-string", "#ccc"),
    pie3: v("code-function", "#ccc"),
    pie4: v("code-keyword", "#ccc"),
    pie5: v("code-number", "#ccc"),
    pie6: v("code-attr", "#ccc"),
    pie7: v("text-muted", "#ccc"),
    pie8: v("border", "#ccc"),
    pie9: v("code-comment", "#ccc"),
    pie10: v("code-tag", "#ccc"),
    pie11: v("background-elevated", "#ccc"),
    pie12: v("background", "#ccc"),
  };
}

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: mermaidThemeVariables(),
  });
}

// Fetches the server-rendered HTML (markdown-it + plugin pipeline) and
// mounts it; the container keeps the toastui-editor-contents class so
// existing content CSS applies unchanged during the transition.

function highlightLines() {
  if (!props.line || !viewerElement.value) return;
  viewerElement.value
    .querySelectorAll("[data-source-line].line-highlight")
    .forEach((el) => el.classList.remove("line-highlight"));
  const from = Math.max(1, props.line.from);
  const to = Math.max(from, props.line.to);
  for (const el of viewerElement.value.querySelectorAll("[data-source-line]")) {
    const n = parseInt(el.getAttribute("data-source-line"), 10) + 1;
    if (n >= from && n <= to) el.classList.add("line-highlight");
  }
}

async function renderNote() {
  if (!props.title || !viewerElement.value) {
    return;
  }
  try {
    const plugins = await getPlugins();
    const disabled = disabledPluginIds(plugins);
    viewerElement.value.innerHTML = await getRenderedHtml(
      props.title,
      disabled,
      viewLineNumbers.value,
    );
  } catch (error) {
    console.error("Note render failed", error);
    viewerElement.value.innerHTML =
      '<p class="render-error">Failed to render this note.</p>';
    loaded.value = true;
    return;
  }
  addCopyButtons(viewerElement.value);
  loaded.value = true;
  initMermaid();
  mermaid
    .run({ nodes: viewerElement.value.querySelectorAll(".mermaid") })
    .catch((error) => console.error("Mermaid rendering failed", error));
  renderMathInElement(viewerElement.value, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  });
  highlightLines();
}

onMounted(renderNote);
watch(() => props.title, renderNote);
// Re-render when the line-numbers-in-view-mode toggle changes.
watch(viewLineNumbers, renderNote);
// Re-highlight when the #view:L fragment changes (no re-render needed).
watch(() => props.line, highlightLines);
subscribe(TOPICS.PLUGIN_TOGGLE, renderNote);
subscribe(TOPICS.PLUGIN_AUTO_ENABLE, renderNote);
// Re-render on theme switch so mermaid picks up the new mode's theme.
subscribe(TOPICS.THEME_CHANGE, renderNote);
</script>

<style>
@import "katex/dist/katex.min.css";
@import "./toastui/toastui-editor-overrides.css";
</style>
