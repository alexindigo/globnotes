<template>
  <!-- Mask -->
  <div
    v-if="isVisible"
    class="fixed left-0 top-0 z-50 flex h-dvh w-dvw items-start justify-center bg-slate-950/40 backdrop-blur-sm"
    @click.self="closeHandler"
  >
    <!-- Modal -->
    <div
      class="relative mx-2 mt-[30vh] max-w-[500px] grow rounded-lg border border-theme-border bg-theme-background shadow-lg"
      :class="$attrs.class"
    >
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, watch } from "vue";

import { publish, TOPICS } from "../bus/index.js";

defineOptions({
  inheritAttrs: false,
});
const props = defineProps({
  closeHandlerOverride: Function,
  name: { type: String, default: undefined },
});
const isVisible = defineModel({ type: Boolean });

// Modals are global overlays — publish open/close on the bus.
watch(isVisible, (visible) => {
  publish(visible ? TOPICS.MODAL_OPEN : TOPICS.MODAL_CLOSE, { name: props.name });
});

// Escape dismisses the modal: direct document listener guarded by this
// instance's visibility (Mousetrap's global binding leaked across modals and
// reached none of them reliably).
function onEsc(event) {
  if (event.key === "Escape" && isVisible.value) {
    closeHandler();
  }
}
onMounted(() => document.addEventListener("keydown", onEsc));
onBeforeUnmount(() => document.removeEventListener("keydown", onEsc));

function closeHandler() {
  if (props.closeHandlerOverride) {
    props.closeHandlerOverride();
  } else {
    isVisible.value = false;
  }
}
</script>
