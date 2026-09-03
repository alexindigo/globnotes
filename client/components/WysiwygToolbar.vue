// SPDX-License-Identifier: LGPL-3.0-only

<template>
  <div class="wysiwyg-toolbar-wrap relative">
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
        <Icon v-if="btn.icon" icon="btn.icon" size="16" />
        <span v-else>{{ btn.label }}</span>
      </button>

      <!-- Link popover: replaces window.prompt() for URL/text -->
      <div
        v-if="linkPopoverOpen"
        class="link-popover"
        @keydown.esc="closeLinkPopover"
      >
        <input
          ref="linkHrefInput"
          v-model="linkHref"
          type="text"
          class="link-input"
          placeholder="https://…"
          aria-label="Link URL"
        />
        <div class="link-pop-actions flex items-center gap-1">
          <button type="button" class="toolbar-btn" title="Apply link" @click="applyLink">
            <Icon icon="tabCheck" size="16" aria-label="Apply" />
          </button>
          <button type="button" class="toolbar-btn" title="Remove link" @click="applyRemoveLink">
            <Icon icon="tabLinkOff" size="16" aria-label="Remove link" />
          </button>
          <button type="button" class="toolbar-btn" title="Cancel" @click="closeLinkPopover">
            <Icon icon="tabClose" size="16" aria-label="Cancel" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import Icon from "../components/Icon.vue";
import {
  tabCheck,
  tabClose,
  tabBraces,
  tabCode,
  tabBold,
  tabItalic,
  tabList,
  tabListNumbers,
  tabQuote,
  tabStrikethrough,
  tabLink,
  tabLinkOff,
} from "../icons.js";
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  /** Reference to WysiwygEditorInner (exposes command/active/link APIs). */
  innerRef: Object,
  /** Active-formatting state pushed up from ProseMirror selection changes. */
  activeState: Object,
});

const active = ref({});

// Link popover state
const linkPopoverOpen = ref(false);
const linkHref = ref("");
const linkText = ref("");
const linkHrefInput = ref();

const buttons = [
  { name: "bold", title: "Bold", icon: tabBold },
  { name: "italic", title: "Italic", icon: tabItalic },
  { name: "strike", title: "Strikethrough", icon: tabStrikethrough },
  { name: "inlineCode", title: "Inline code", icon: tabCode },
  { name: "link", title: "Link", icon: tabLink },
  { name: "h1", title: "Heading 1", label: "H1" },
  { name: "h2", title: "Heading 2", label: "H2" },
  { name: "h3", title: "Heading 3", label: "H3" },
  { name: "bulletList", title: "Bullet list", icon: tabList },
  { name: "orderedList", title: "Ordered list", icon: tabListNumbers },
  { name: "blockquote", title: "Quote", icon: tabQuote },
  { name: "codeBlock", title: "Code block", icon: tabBraces },
];

function isActive(btn) {
  const a = props.activeState ?? active.value ?? {};
  if (btn.name.startsWith("h")) return a.heading === btn.name;
  if (btn.name === "link") return !!a.link;
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
    openLinkPopover();
    return;
  }
  linkPopoverOpen.value = false;
  inner.command(btn.name);
  refreshActive();
}

function openLinkPopover() {
  const inner = props.innerRef;
  // Pre-fill when the cursor is already inside a link.
  const existing = inner?.getLinkAtSelection?.();
  linkHref.value = existing?.href ?? "";
  linkText.value = existing?.text ?? "";
  linkPopoverOpen.value = true;
  nextTick(() => linkHrefInput.value?.focus());
}

function closeLinkPopover() {
  linkPopoverOpen.value = false;
  props.innerRef?.focus?.();
}

function applyLink() {
  const inner = props.innerRef;
  if (!inner?.insertLink) return;
  const href = linkHref.value.trim();
  if (!href) {
    // Empty URL with an active link acts as remove.
    inner.removeLink?.();
    closeLinkPopover();
    refreshActive();
    return;
  }
  inner.insertLink(href, linkText.value.trim() || undefined);
  closeLinkPopover();
  refreshActive();
}

function applyRemoveLink() {
  const inner = props.innerRef;
  if (!inner?.removeLink) return;
  inner.removeLink();
  closeLinkPopover();
  refreshActive();
}

function onSelectionChange() {
  refreshActive();
}

onMounted(() => {
  // The ProseMirror plugin in WysiwygEditorInner pushes active-formatting
  // updates on every cursor move / mark toggle (selectionchange fires too).
  document.addEventListener("selectionchange", onSelectionChange);
});

onBeforeUnmount(() => {
  document.removeEventListener("selectionchange", onSelectionChange);
});

defineExpose({ refreshActive, openLinkPopover });
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
/* Link popover */
.wysiwyg-toolbar-wrap .link-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border: 1px solid rgb(var(--theme-border));
  border-radius: 6px;
  background-color: rgb(var(--theme-background-elevated));
  box-shadow: 0 6px 18px rgb(var(--theme-shadow));
}
.wysiwyg-toolbar-wrap .link-popover .link-input {
  width: 220px;
  padding: 3px 8px;
  border: 1px solid rgb(var(--theme-border));
  border-radius: 4px;
  background-color: rgb(var(--theme-background));
  color: rgb(var(--theme-text));
  font-size: 0.8rem;
  outline: none;
}
.wysiwyg-toolbar-wrap .link-popover .link-input:focus {
  border-color: rgb(var(--theme-brand));
}
</style>
