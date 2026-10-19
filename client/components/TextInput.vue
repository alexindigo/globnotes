<template>
  <input
    :type="type"
    class="text-input focus-ring min-w-0 w-full"
    :class="{
      'min-h-11 rounded-md border border-theme-border px-3 py-2 dark:bg-theme-background-elevated': variant === 'field',
      'bg-theme-background': variant === 'plain',
      'bg-theme-background text-sm text-theme-text-muted': variant === 'plain-muted',
      'rounded-md border border-theme-border bg-theme-background px-4 py-3 text-theme-text': variant === 'search',
      'rounded border border-theme-border bg-theme-background px-2 py-[3px] text-[0.8rem] text-theme-text focus:border-theme-brand': variant === 'compact',
    }"
    :value="model"
    @input="model = $event.target.value"
    ref="input"
  />
</template>

<script setup>
import { ref } from "vue";

defineProps({
  // Opt-in input type (default text) — e.g. password fields in setup.
  type: { type: String, default: "text" },
  variant: { type: String, default: 'field', validator: value => ['field','plain','plain-muted','search','compact'].includes(value) },
});
const model = defineModel();
const input = ref();
defineExpose({ focus: () => input.value?.focus(), selectionStart: () => input.value?.selectionStart ?? 0 });
</script>
