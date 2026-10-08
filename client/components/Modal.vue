<template>
  <Teleport :to="dialogHost || 'body'" :disabled="!dialogHost">
  <!-- Mask -->
  <div
    v-if="isVisible"
    class="fixed left-0 top-0 z-50 flex h-dvh w-dvw justify-center bg-slate-950/40 backdrop-blur-sm"
    :class="anchor === 'viewport-center' ? 'items-center' : 'items-start'"
    :inert="ownership && !ownership.topmost.value ? '' : undefined"
    :data-modal-top="ownership?.topmost.value ? 'true' : 'false'"
    :style="{ zIndex: 50 + (ownership?.level.value ?? 0) }"
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
      tabindex="-1"
    >
      <slot></slot>
    </div>
  </div>
  </Teleport>
</template>

<script setup>
import { inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { publish, TOPICS } from "../bus/index.js";
import { DIALOG_HOST, registerModal } from "../modalState.js";

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
  keydownHandler: Function,
});
const isVisible = defineModel({ type: Boolean });
const rootEl = ref(null);
const dialogHost = inject(DIALOG_HOST, null);
const ownership = shallowRef(null);
let opener = null;
let closing = false;

// Modals are global overlays — publish open/close on the bus.
function open() {
  if (ownership.value || !isVisible.value) return;
  opener = document.activeElement;
  ownership.value = registerModal({
    name: props.name, onEscape: closeHandler, onTab: onTab,
    onKeydown: event => props.keydownHandler?.(event),
    focusInitial: () => {
      if (props.trapFocus) {
        const targets=focusables();
        if(rootEl.value?.contains(document.activeElement)&&targets.includes(document.activeElement))return;
        (targets[0] ?? rootEl.value)?.focus();
      }
    },
    restoreFocus: () => nextTick(() => {
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
    }),
  });
  publish(TOPICS.MODAL_OPEN, { name: props.name });
  nextTick(() => ownership.value?.focus());
}
function release() {
  if (!ownership.value) return;
  ownership.value.dispose();
  ownership.value = null;
  publish(TOPICS.MODAL_CLOSE, { name: props.name });
}
watch(isVisible, visible => visible ? open() : release(), { flush: "post" });

// Direct document listener guarded by this instance's visibility (Mousetrap's
// global binding leaked across modals and reached none of them reliably).
function focusables() {
  return [...(rootEl.value?.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
    .filter(el => {
      if(el.matches('input[type="hidden"], :disabled') || el.closest('[hidden], [inert], [aria-hidden="true"]'))return false;
      for(let node=el;node&&rootEl.value?.contains(node);node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden')return false;}
      return true;
    });
}
function onTab(event) {
  // Opt-in focus containment: Tab/Shift+Tab cycle the dialog's interactive
  // elements. Exclusions are markup-level (inert / aria-hidden / disabled)
  // rather than layout-level (offsetParent) so hidden panels stay out in
  // both the browser and jsdom.
  if (props.trapFocus && rootEl.value) {
    const focusable = focusables();
    if (!focusable.length) { event.preventDefault(); rootEl.value.focus(); return true; }
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
    return true;
  }
  return false;
}
onMounted(open);
onBeforeUnmount(release);

async function closeHandler() {
  if (closing || !ownership.value?.topmost.value) return;
  closing = true;
  try {
  if (props.closeHandlerOverride) {
    await props.closeHandlerOverride();
  } else {
    isVisible.value = false;
  }
  } finally { closing = false; }
}
defineExpose({ focus: () => ownership.value?.focus() });
</script>
