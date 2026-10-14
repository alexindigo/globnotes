<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <span v-if="runsInBrowser" class="inline-flex items-center rounded border border-theme-warning px-2 py-0.5 text-xs text-theme-text" data-plugin-browser-badge :title="description">
    Runs in browser
  </span>
</template>
<script setup>
import { computed } from "vue";
const props = defineProps({ runsInBrowser: Boolean, browserComponents: { type: Array, default: () => [] } });
const description = computed(() => `Trusted browser code (${props.browserComponents.join(', ') || 'browser component'}). Server network approvals do not restrict it.`);
</script>
