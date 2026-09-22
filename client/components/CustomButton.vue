<template>
  <button
    class="flex items-center justify-center text-nowrap rounded"
    :disabled="disabled"
    :title="title"
    :class="[
      variant === 'cta' ? 'px-4 py-2.5 font-semibold' : 'px-2 py-1',
      {
        'bg-theme-background text-theme-text-muted enabled:hover:bg-theme-background-elevated enabled:hover:text-theme-brand':
          variant === 'subtle',
        'bg-theme-brand text-white [-webkit-text-stroke:1.5px_rgb(75_85_99)] [paint-order:stroke_fill] enabled:hover:opacity-90':
          variant === 'cta',
        'border border-theme-danger text-theme-danger enabled:hover:bg-theme-danger/10':
          variant === 'danger',
        'border border-theme-success text-theme-success enabled:hover:bg-theme-success/10':
          variant === 'success',
        'opacity-40': disabled,
      },
    ]"
  >
    <slot></slot>
    <IconLabel :iconPath="iconPath" :iconSize="iconSize" :label="label" />
  </button>
</template>

<script setup>
import IconLabel from "./IconLabel.vue";

defineProps({
  iconPath: String,
  iconSize: String,
  label: String,
  title: String,
  disabled: Boolean,
  // NOTE: must not be named `style` — Vue reserves that attr and the
  // variant never reached the props (everything rendered default).
  variant: {
    type: String,
    default: "subtle",
    validator: (value) => {
      return ["subtle", "cta", "danger", "success"].includes(value);
    },
  },
});
</script>
