<template>
  <Modal v-model="isVisible" name="search" anchor="center" class="border-none">
    <div class="p-3">
      <SwitcherPanel @opened="isVisible = false" />
    </div>
  </Modal>
</template>

<script setup>
import Modal from "./Modal.vue";
import SwitcherPanel from "./SwitcherPanel.vue";

const isVisible = defineModel({ type: Boolean });
</script>
