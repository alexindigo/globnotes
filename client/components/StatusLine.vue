<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <p class="status-line" role="status" aria-atomic="true" :title="message || undefined">{{ message }}</p>
</template>
<script setup>
defineProps({ message: { type: String, default: "" } });
</script>
<style scoped>
/* Reserve one inherited typographic line for every status snapshot. CSS
   truncation preserves the full text for assistive technology and the title. */
.status-line { display: block; box-sizing: content-box; block-size: 1lh; min-block-size: 1lh; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
