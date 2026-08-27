<template>
  <div
    ref="viewerElement"
    class="rendered-markdown"
    :class="{ 'toastui-editor-contents': loaded }"
  ></div>
</template>

<script setup>
import { mdiCheck, mdiContentCopy } from "@mdi/js";
import renderMathInElement from "katex/contrib/auto-render/auto-render.js";
import mermaid from "mermaid";
import { onMounted, ref, watch } from "vue";

import { getPlugins, getRenderedHtml } from "../api.js";
import { subscribe, TOPICS } from "../bus/index.js";
import { disabledPluginIds, viewLineNumbers } from "../pluginSettings.js";

const props = defineProps({
  title: String,
});

const viewerElement = ref();
// The container class appears only when content does — the old viewer
// rendered both atomically, and e2e/style hooks poll the class.
const loaded = ref(false);

const COPY_ICON = `<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="${mdiContentCopy}"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="${mdiCheck}"/></svg>`;

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

mermaid.initialize({ startOnLoad: false });

// Fetches the server-rendered HTML (markdown-it + plugin pipeline) and
// mounts it; the container keeps the toastui-editor-contents class so
// existing content CSS applies unchanged during the transition.
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
}

onMounted(renderNote);
watch(() => props.title, renderNote);
// Re-render when the line-numbers-in-view-mode toggle changes.
watch(viewLineNumbers, renderNote);
subscribe(TOPICS.PLUGIN_TOGGLE, renderNote);
subscribe(TOPICS.PLUGIN_AUTO_ENABLE, renderNote);
</script>

<style>
@import "katex/dist/katex.min.css";
@import "./toastui/toastui-editor-overrides.css";
</style>
