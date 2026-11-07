<template>
  <span><template v-for="(segment, index) in segments" :key="index"><b v-if="segment.match" class="match term0">{{ segment.text }}</b><template v-else>{{ segment.text }}</template></template></span>
</template>

<script setup>
import { computed } from "vue";
import { highlightSegments } from "../highlightText.js";

const props = defineProps({ text: { type: String, default: "" }, highlighted: Boolean });
const segments = computed(() => highlightSegments(props.text, props.highlighted));
</script>

<style scoped>
.match {
  @apply text-theme-brand;
}
</style>
