// SPDX-License-Identifier: LGPL-3.0-only

<template>
  <div
    ref="wrapper"
    class="milkdown-frame toastui-editor-contents flex min-h-0 flex-1 flex-col overflow-hidden"
  >
    <WysiwygToolbar
      ref="toolbar"
      :innerRef="inner"
      :activeState="activeState"
    />
    <div class="wysiwyg-scroll min-h-0 flex-1 overflow-y-auto">
      <MilkdownProvider>
        <WysiwygEditorInner
          ref="inner"
          :initialValue="initialValue"
          :addImageBlobHook="addImageBlobHook"
          @change="onChange"
          @activeChange="onActiveChange"
        />
      </MilkdownProvider>
    </div>
  </div>
</template>

<script setup>
import { MilkdownProvider } from "@milkdown/vue";
import { onBeforeUnmount, onMounted, ref } from "vue";

import { subscribe, TOPICS } from "../bus/index.js";
import WysiwygEditorInner from "./WysiwygEditorInner.vue";
import WysiwygToolbar from "./WysiwygToolbar.vue";

defineProps({
  initialValue: String,
  addImageBlobHook: Function,
});

const emit = defineEmits(["change", "keydown"]);

const wrapper = ref();
const inner = ref();
const toolbar = ref();
const activeState = ref({});
let actionUnsubs = [];

onBeforeUnmount(() => {
  actionUnsubs.forEach((fn) => fn());
  actionUnsubs = [];
});

function onChange() {
  emit("change");
  toolbar.value?.refreshActive();
}

function onActiveChange(payload) {
  activeState.value = payload ?? {};
}

onMounted(() => {
  // ProseMirror keydown bubbles; forward for the host's shortcuts.
  wrapper.value?.addEventListener(
    "keydown",
    (event) => emit("keydown", event),
    true,
  );
  // The wrapper owns the toolbar, so editor:insert-link lands here: open
  // the link popover (prefilled from any link at the selection).
  actionUnsubs.push(
    subscribe(TOPICS.EDITOR_INSERT_LINK, () => {
      toolbar.value?.openLinkPopover?.();
    }),
  );
});

function getMarkdown() {
  return inner.value?.getMarkdown() ?? "";
}

function setMarkdown(markdownText) {
  inner.value?.setMarkdown(markdownText);
}

function isWysiwygMode() {
  return true;
}

defineExpose({ getMarkdown, setMarkdown, isWysiwygMode });
</script>

<style>
/* Visible editor frame so the edit surface reads as a bounded box. */
.milkdown-frame {
  border: 1px solid rgb(var(--theme-border));
  border-radius: 8px;
  background-color: rgb(var(--theme-background));
}
.wysiwyg-scroll {
  padding: 12px 16px;
}
/* Minimal Milkdown/ProseMirror chrome; content styles come from the
   shared overrides (the editor root also carries the toastui classes). */
.milkdown-frame .ProseMirror {
  outline: none;
  min-height: 100%;
}
.milkdown-frame .ProseMirror-focused {
  outline: none;
}
</style>
