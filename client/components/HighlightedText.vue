<template>
  <span>
    <span
      v-for="(seg, i) in segments"
      :key="i"
      :class="seg.matched ? 'font-semibold text-theme-brand' : undefined"
    >{{ seg.text }}</span>
  </span>
</template>

<script setup>
// Renders text with the fuzzy-matched characters highlighted (accent
// color). Unmatched runs inherit the surrounding text style.
import { computed } from "vue";

import { highlightSegments } from "../fuzzy.js";

const props = defineProps({
  text: { type: String, default: "" },
  positions: { type: Array, default: () => [] },
});

const segments = computed(() =>
  highlightSegments(props.text ?? "", props.positions ?? []));
</script>
