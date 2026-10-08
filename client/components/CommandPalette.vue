<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <Modal
    v-model="isVisible"
    name="palette"
    anchor="center"
    class="border-none"
    labelledby="command-palette-title"
    trap-focus
  >
    <div class="flex max-h-[60dvh] min-h-0 w-full flex-1 flex-col p-3">
      <h2 id="command-palette-title" class="sr-only">Command palette</h2>
      <CommandPalettePanel ref="panel" @run="onRun" />
    </div>
  </Modal>
</template>

<script setup>
import { nextTick, ref, watch } from "vue";

import Modal from "./Modal.vue";
import CommandPalettePanel from "./CommandPalettePanel.vue";
import { runCommand } from "../commands.js";

const isVisible = defineModel({ type: Boolean });
const emit = defineEmits(["run"]);

const panel = ref();

watch(isVisible, async (visible) => {
  if (!visible) return;
  await nextTick();
  panel.value?.focus?.();
});

async function onRun(topic) {
  isVisible.value = false;
  await nextTick();
  try { const result=await runCommand(topic,{});emit("run",topic,result); }
  catch(error) { console.error(`command '${topic}' failed`,error); }
}
</script>
