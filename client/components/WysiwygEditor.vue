<template>
  <div
    ref="wrapper"
    class="milkdown-host toastui-editor-contents min-h-0 flex-1 overflow-y-auto"
  >
    <MilkdownProvider>
      <WysiwygEditorInner
        ref="inner"
        :initialValue="initialValue"
        :addImageBlobHook="addImageBlobHook"
        @change="emit('change')"
      />
    </MilkdownProvider>
  </div>
</template>

<script setup>
import { MilkdownProvider } from "@milkdown/vue";
import { onMounted, ref } from "vue";

import WysiwygEditorInner from "./WysiwygEditorInner.vue";

defineProps({
  initialValue: String,
  addImageBlobHook: Function,
});

const emit = defineEmits(["change", "keydown"]);

const wrapper = ref();
const inner = ref();

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
/* Minimal Milkdown/ProseMirror chrome; content styles come from the
   shared overrides (the editor root also carries the toastui classes). */
.milkdown-host .ProseMirror {
  outline: none;
  min-height: 100%;
}
.milkdown-host .ProseMirror-focused {
  outline: none;
}
</style>
