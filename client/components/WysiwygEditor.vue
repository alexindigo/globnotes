// SPDX-License-Identifier: LGPL-3.0-only

<template>
  <div
    ref="wrapper"
    class="milkdown-frame toastui-editor-contents min-h-0 flex-1 overflow-hidden flex flex-col"
  >
    <WysiwygToolbar ref="toolbar" :innerRef="inner" :activeState="activeState" />
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
import { onMounted, ref } from "vue";

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
