<template>
  <div class="conflict-comparison" aria-label="Compared files">
    <ConflictVersion label="Original" :member="pair.original" :href="originalHref" :on-open="onOpen" />
    <ConflictVersion label="Conflict copy" :member="pair.copy" :href="copyHref" :on-open="onOpen" />
  </div>
</template>
<script setup>
import ConflictVersion from "./ConflictVersion.vue";
defineProps({ pair: { type: Object, required: true }, originalHref: String, copyHref: String, onOpen: Function });
</script>
<style scoped>
.conflict-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; min-width: 0; }
@container (max-width: 40rem) { .conflict-comparison { grid-template-columns: minmax(0, 1fr); } }
</style>
