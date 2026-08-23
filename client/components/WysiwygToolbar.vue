// SPDX-License-Identifier: LGPL-3.0-only

<template>
  <div
    class="wysiwyg-toolbar flex items-center gap-1 border-b border-theme-border bg-theme-background-elevated px-2 py-1"
  >
    <button
      v-for="btn in buttons"
      :key="btn.name"
      type="button"
      class="toolbar-btn"
      :class="{ active: isActive(btn) }"
      :title="btn.title"
      :aria-label="btn.title"
      @mousedown.prevent
      @click="apply(btn)"
    >
      <SvgIcon v-if="btn.icon" type="mdi" :path="btn.icon" width="16" height="16" />
      <span v-else>{{ btn.label }}</span>
    </button>
  </div>
</template>

<script setup>
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiCodeBraces,
  mdiCodeTags,
  mdiFormatBold,
  mdiFormatItalic,
  mdiFormatListBulleted,
  mdiFormatListNumbered,
  mdiFormatQuoteClose,
  mdiFormatStrikethrough,
} from "@mdi/js";
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  /** Reference to WysiwygEditorInner (exposes command/active). */
  innerRef: Object,
});

const active = ref({});

const buttons = [
  { name: "bold", title: "Bold", icon: mdiFormatBold },
  { name: "italic", title: "Italic", icon: mdiFormatItalic },
  { name: "strike", title: "Strikethrough", icon: mdiFormatStrikethrough },
  { name: "inlineCode", title: "Inline code", icon: mdiCodeTags },
  { name: "link", title: "Link", label: "🔗" },
  { name: "h1", title: "Heading 1", label: "H1" },
  { name: "h2", title: "Heading 2", label: "H2" },
  { name: "h3", title: "Heading 3", label: "H3" },
  { name: "bulletList", title: "Bullet list", icon: mdiFormatListBulleted },
  { name: "orderedList", title: "Ordered list", icon: mdiFormatListNumbered },
  { name: "blockquote", title: "Quote", icon: mdiFormatQuoteClose },
  { name: "codeBlock", title: "Code block", icon: mdiCodeBraces },
];

function isActive(btn) {
  const a = active.value || {};
  if (btn.name.startsWith("h")) return a.heading === btn.name;
  return !!a[btn.name];
}

function refreshActive() {
  const inner = props.innerRef;
  if (inner?.active) {
    active.value = inner.active();
  }
}

function apply(btn) {
  const inner = props.innerRef;
  if (!inner?.command) return;
  if (btn.name === "link") {
    const href = window.prompt("Link URL:");
    if (!href) return;
    const text = window.prompt("Link text (blank keeps selection):") ?? "";
    inner.insertLink(href, text || undefined);
    return;
  }
  inner.command(btn.name);
  refreshActive();
}

function onSelectionChange() {
  refreshActive();
}

onMounted(() => {
  document.addEventListener("selectionchange", onSelectionChange);
});

onBeforeUnmount(() => {
  document.removeEventListener("selectionchange", onSelectionChange);
});

defineExpose({ refreshActive });
</script>

<style>
.wysiwyg-toolbar .toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border-radius: 4px;
  color: rgb(var(--theme-text-muted));
  font-size: 0.72rem;
  cursor: pointer;
  transition: background-color 80ms ease, color 80ms ease;
}
.wysiwyg-toolbar .toolbar-btn:hover {
  background-color: rgb(var(--theme-shadow));
  color: rgb(var(--theme-text));
}
.wysiwyg-toolbar .toolbar-btn.active {
  background-color: rgb(var(--theme-shadow));
  color: rgb(var(--theme-brand));
}
</style>
