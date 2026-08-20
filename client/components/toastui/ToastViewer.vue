<template>
  <div ref="viewerElement"></div>
</template>

<script setup>
import Viewer from "@toast-ui/editor/dist/toastui-editor-viewer";
import renderMathInElement from "katex/contrib/auto-render/auto-render.js";
import { mdiCheck, mdiContentCopy } from "@mdi/js";
import mermaid from "mermaid";
import { onMounted, ref } from "vue";

import { preprocessObsidianFlavored } from "../../obsidianFlavored.js";
import baseOptions from "./baseOptions.js";
import extendedAutolinks from "./extendedAutolinks.js";

const props = defineProps({
  initialValue: String,
});

const viewerElement = ref();

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

onMounted(() => {
  new Viewer({
    ...baseOptions,
    extendedAutolinks,
    el: viewerElement.value,
    initialValue: preprocessObsidianFlavored(props.initialValue),
  });
  // customHTMLRenderer (mermaid support) shadows the code-syntax-highlight
  // plugin's renderer, so highlight code blocks explicitly after mount.
  if (window.Prism?.highlightAllUnder) {
    window.Prism.highlightAllUnder(viewerElement.value);
  }
  addCopyButtons(viewerElement.value);
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
});
</script>

<style>
@import "@toast-ui/editor/dist/toastui-editor-viewer.css";
@import "@toast-ui/editor-plugin-code-syntax-highlight/dist/toastui-editor-plugin-code-syntax-highlight.css";
@import "katex/dist/katex.min.css";
@import "./toastui-editor-overrides.scss";
</style>
