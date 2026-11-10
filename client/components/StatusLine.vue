<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <p class="status-line" role="status" aria-atomic="true" :title="message || undefined">{{ message }}</p>
</template>
<script setup>
defineProps({ message: { type: String, default: "" } });
</script>
<style scoped>
/* Reserve the same line for empty, pending and complete status snapshots. CSS
   truncation preserves the full text for assistive technology and the title. */
.status-line { display: block; box-sizing: content-box; block-size: 1.25rem; min-block-size: 1.25rem; line-height: 1.25rem; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
