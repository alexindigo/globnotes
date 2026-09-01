<template>
  <!-- Mask -->
  <div
    v-if="isVisible"
    class="fixed left-0 top-0 z-50 flex h-dvh w-dvw items-start justify-center bg-slate-950/40 backdrop-blur-sm"
    @click.self="closeHandler"
  >
    <!-- Modal -->
    <!-- anchor="top" (default): legacy 30vh top anchor. anchor="center":
         box top edge pins at page-center minus --switcher-lift minus the
         content wrapper's 12px inset (p-3), so the framed input lands on
         the same line as Home's bare input; the box grows downward. -->
    <div
      class="rounded-lg border border-theme-border bg-theme-background shadow-lg"
      :class="[
        anchor === 'center'
          ? 'absolute left-1/2 top-[calc(50%-var(--switcher-lift)-12px)] w-[calc(100%-1rem)] max-w-[524px] -translate-x-1/2 max-h-[calc(50dvh+var(--switcher-lift)-1rem)]'
          : 'relative mx-2 mt-[30vh] max-w-[500px] grow',
        $attrs.class,
      ]"
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
  anchor: { type: String, default: "top" },
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
