<template>
  <!-- Mask -->
  <div
    v-if="isVisible"
    class="fixed left-0 top-0 z-50 flex h-dvh w-dvw justify-center bg-slate-950/40 backdrop-blur-sm"
    :class="anchor === 'viewport-center' ? 'items-center' : 'items-start'"
    @click.self="closeHandler"
  >
    <!-- Modal -->
    <!-- anchor="top" (default): legacy 30vh top anchor. anchor="center":
         box top edge pins at page-center minus --switcher-lift minus the
         content wrapper's 12px inset (p-3), so the framed input lands on
         the same line as Home's bare input; the box grows downward.
         anchor="viewport-center": genuinely viewport-bounded centered dialog
         (setup wizard) — flex-centered, scrollable within the viewport. -->
    <div
      ref="rootEl"
      class="rounded-lg border border-theme-border bg-theme-background shadow-lg"
      :class="[
        anchor === 'center'
          ? 'absolute left-1/2 top-[calc(50%-var(--switcher-lift)-12px)] flex w-[calc(100%-1rem)] max-w-[524px] -translate-x-1/2 flex-col overflow-hidden max-h-[calc(50dvh+var(--switcher-lift)-1rem)]'
          : anchor === 'viewport-center'
            ? 'relative mx-4 flex h-[80dvh] w-[80dvw] flex-col overflow-y-auto [scrollbar-gutter:stable]'
            : 'relative mx-2 mt-[30vh] max-w-[500px] grow',
        $attrs.class,
      ]"
      :role="labelledby ? 'dialog' : undefined"
      :aria-modal="labelledby ? 'true' : undefined"
      :aria-labelledby="labelledby || undefined"
    >
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { publish, TOPICS } from "../bus/index.js";

defineOptions({
  inheritAttrs: false,
});
const props = defineProps({
  closeHandlerOverride: Function,
  name: { type: String, default: undefined },
  anchor: { type: String, default: "top" },
  // Opt-in dialog semantics: id of the element naming the dialog.
  labelledby: { type: String, default: undefined },
  // Opt-in Tab containment within the dialog (first-run setup).
  trapFocus: { type: Boolean, default: false },
});
const isVisible = defineModel({ type: Boolean });
const rootEl = ref(null);

// Modals are global overlays — publish open/close on the bus.
watch(isVisible, (visible) => {
  publish(visible ? TOPICS.MODAL_OPEN : TOPICS.MODAL_CLOSE, { name: props.name });
});

// Direct document listener guarded by this instance's visibility (Mousetrap's
// global binding leaked across modals and reached none of them reliably).
function onKeydown(event) {
  if (!isVisible.value) return;
  if (event.key === "Escape") {
    closeHandler();
    return;
  }
  // Opt-in focus containment: Tab/Shift+Tab cycle the dialog's interactive
  // elements. Exclusions are markup-level (inert / aria-hidden / disabled)
  // rather than layout-level (offsetParent) so hidden panels stay out in
  // both the browser and jsdom.
  if (event.key === "Tab" && props.trapFocus && rootEl.value) {
    const focusable = [
      ...rootEl.value.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), ' +
          "select:not([disabled]), textarea:not([disabled]), " +
          '[tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.closest('[inert], [aria-hidden="true"]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!rootEl.value.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

function closeHandler() {
  if (props.closeHandlerOverride) {
    props.closeHandlerOverride();
  } else {
    isVisible.value = false;
  }
}
</script>
