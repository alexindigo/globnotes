<template>
  <Modal v-model="isVisible" name="search" anchor="center" class="border-none">
    <div class="p-3">
      <SwitcherPanel ref="panel" @opened="onPanelOpened" />
    </div>
  </Modal>
</template>

<script setup>
import { nextTick, ref, watch } from "vue";

import Modal from "./Modal.vue";
import SwitcherPanel from "./SwitcherPanel.vue";

const props = defineProps({
  initialFocusEvent: { type: Object, default: null },
});
const isVisible = defineModel({ type: Boolean });
const emit = defineEmits(["opened"]);

const panel = ref();

// Home's search box hands over to this modal. To keep the handoff visible we
// re-focus the modal's input with the same FocusEvent the browser fired on
// Home, so the caret lands as close as rendered geometry allows. The plain
// navbar path focuses with no event. Clearing `@opened` re-arms the trick.
watch(isVisible, async (visible) => {
  if (!visible) return;
  await nextTick();
  const event = props.initialFocusEvent;
  panel.value?.focus?.(event ?? undefined);
  if (event) emit("opened");
});

function onPanelOpened() {
  isVisible.value = false;
}
</script>
