<template>
  <div ref="viewerElement"></div>
</template>

<script setup>
import Viewer from "@toast-ui/editor/dist/toastui-editor-viewer";
import renderMathInElement from "katex/contrib/auto-render/auto-render.js";
import mermaid from "mermaid";
import { onMounted, ref } from "vue";

import { preprocessObsidianFlavored } from "../../obsidianFlavored.js";
import baseOptions from "./baseOptions.js";
import extendedAutolinks from "./extendedAutolinks.js";

const props = defineProps({
  initialValue: String,
});

const viewerElement = ref();

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
