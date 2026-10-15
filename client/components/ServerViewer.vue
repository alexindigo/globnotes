<template>
  <div
    ref="viewerElement"
    :class="{ 'rendered-markdown': loaded, 'toastui-editor-contents': loaded }"
    @click="handleAnchorClick"
  ></div>
</template>

<script setup>
import { tabCheck, tabCopy } from "../icons.js";
import renderMathInElement from "katex/contrib/auto-render/auto-render.js";
import mermaid from "mermaid";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { copyText } from "../clipboard.js";
import { handleAnchorClick } from "../anchorClicks.js";
import { createServerViewer } from "../serverViewer.js";
import { mermaidThemeVariables } from "../mermaidTheme.js";
import { viewLineNumbers } from "../pluginSettings.js";

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
      await copyText(text);
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

const viewer = createServerViewer({
  getContext: () => ({ title: props.title, root: viewerElement.value }),
  setHtml: html => { viewerElement.value.innerHTML = html; },
  failed: () => {
    viewerElement.value.innerHTML =
      '<p class="render-error">Failed to render this note.</p>';
    loaded.value = true;
  },
  rendered: isCurrent => {
    const root = viewerElement.value;
    addCopyButtons(root);
    loaded.value = true;
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: mermaidThemeVariables(),
    });
    mermaid
      .run({ nodes: root.querySelectorAll(".mermaid") })
      .catch((error) => {
        if (isCurrent()) console.error("Mermaid rendering failed", error);
      });
    renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
    highlightLines();
  },
});

onMounted(viewer.renderNote);
watch(() => props.title, viewer.renderNote);
// Re-render when the line-numbers-in-view-mode toggle changes.
watch(viewLineNumbers, viewer.renderNote);
// Re-highlight when the #view:L fragment changes (no re-render needed).
watch(() => props.line, highlightLines);
onBeforeUnmount(viewer.dispose);
</script>

<style>
@import "katex/dist/katex.min.css";
@import "./toastui/toastui-editor-overrides.css";
</style>
