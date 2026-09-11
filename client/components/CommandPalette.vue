<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <Modal
    v-model="isVisible"
    name="palette"
    anchor="center"
    class="border-none"
  >
    <div class="flex max-h-[60dvh] min-h-0 w-full flex-1 flex-col p-3">
      <CommandPalettePanel ref="panel" @run="onRun" />
    </div>
  </Modal>
</template>

<script setup>
import { nextTick, ref, watch } from "vue";

import Modal from "./Modal.vue";
import CommandPalettePanel from "./CommandPalettePanel.vue";

const isVisible = defineModel({ type: Boolean });
const emit = defineEmits(["run"]);

const panel = ref();

watch(isVisible, async (visible) => {
  if (!visible) return;
  await nextTick();
  panel.value?.focus?.();
});

function onRun(topic) {
  emit("run", topic);
  isVisible.value = false;
}
</script>
