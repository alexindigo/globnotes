<template>
  <button
    class="custom-button flex items-center justify-center rounded"
    :disabled="disabled"
    :title="title"
    :class="[
      prominent || variant === 'cta' ? 'px-4 py-2.5 font-semibold' : 'px-2 py-1',
      wrapLabel ? 'min-w-0 whitespace-normal' : 'text-nowrap',
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
    <IconLabel
      :iconPath="iconPath"
      :iconSize="iconSize"
      :iconClass="iconClass"
      :label="label"
      :wrap-label="wrapLabel"
    />
  </button>
</template>

<script setup>
import IconLabel from "./IconLabel.vue";

defineProps({
  iconPath: { type: [Array, String] },
  iconSize: String,
  iconClass: {
    type: [String, Array, Object],
    default: "",
  },
  label: String,
  title: String,
  disabled: Boolean,
  prominent: { type: Boolean, default: false },
  wrapLabel: { type: Boolean, default: false },
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

<style scoped>
.custom-button:focus-visible {
  outline: 2px solid rgb(var(--theme-text));
  outline-offset: 2px;
}
</style>
