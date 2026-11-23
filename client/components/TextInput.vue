<template>
  <div v-if="reveal" class="password-field dark:bg-theme-background-elevated focus-within:ring-1 focus-within:ring-theme-brand">
    <input :type="visible ? 'text' : type" :value="model" class="text-input password-input min-w-0 w-full" @input="model = $event.target.value" v-bind="$attrs" ref="input" />
    <button type="button" class="focus-ring password-eye" :aria-label="visible ? 'Hide password' : 'Show password'" :aria-controls="$attrs.id" :aria-pressed="visible" @click="visible = !visible"><Icon :icon="visible ? tabEye : tabEyeOff" width="18" height="18" /></button>
  </div>
  <input
    v-else
    :type="type"
    class="text-input focus-ring min-w-0 w-full"
    :class="{
      'min-h-11 rounded-md border border-theme-border px-3 py-2 dark:bg-theme-background-elevated': ['field','settings'].includes(variant),
      'settings-text': variant === 'settings',
      'max-w-sm': variant === 'settings' && type !== 'number',
      'max-w-24': variant === 'settings' && type === 'number',
      'bg-theme-background': variant === 'plain',
      'bg-theme-background text-sm text-theme-text-muted': variant === 'plain-muted',
      'rounded-md border border-theme-border bg-theme-background px-4 py-3 text-theme-text': variant === 'search',
      'rounded border border-theme-border bg-theme-background px-2 py-[3px] text-[0.8rem] text-theme-text focus:border-theme-brand': variant === 'compact',
    }"
    :value="model"
    @input="model = $event.target.value"
    v-bind="$attrs"
    ref="input"
  />
</template>

<script setup>
import { ref } from "vue";
import Icon from './Icon.vue';
import { tabEye, tabEyeOff } from '../icons.js';

defineOptions({ inheritAttrs: false });

defineProps({
  // Opt-in input type (default text) — e.g. password fields in setup.
  type: { type: String, default: "text" },
  reveal: { type: Boolean, default: false },
  variant: { type: String, default: 'field', validator: value => ['field','settings','plain','plain-muted','search','compact'].includes(value) },
});
const model = defineModel();
const input = ref();
const visible = ref(false);
defineExpose({ focus: () => input.value?.focus(), selectionStart: () => input.value?.selectionStart ?? 0 });
</script>
<style scoped>
.password-field { display:flex; align-items:stretch; height:44px; overflow:hidden; border:1px solid rgb(var(--theme-border)); border-radius:6px; background:rgb(var(--theme-background)); }
.password-input { flex:1; background:transparent; padding:8px 12px; outline:none; }
.password-eye { display:grid; place-items:center; height:100%; aspect-ratio:1; flex-shrink:0; }
</style>
