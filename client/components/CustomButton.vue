<template>
  <button
    class="custom-button focus-ring flex items-center justify-center rounded"
    :data-variant="variant"
    :disabled="disabled"
    :title="title"
    :class="[
      ['cta','secondary','danger-primary'].includes(variant) || prominent && ['subtle','danger','success'].includes(variant) ? 'px-4 py-2.5 font-semibold' : ['text','danger-text'].includes(variant) ? 'min-h-7 px-0 py-1' : 'px-2 py-1',
      wrapped ? 'min-w-0 max-w-full whitespace-normal' : 'text-nowrap',
      {
        'bg-theme-background enabled:hover:bg-theme-background-elevated enabled:hover:text-theme-brand':
          variant === 'subtle',
        'text-theme-text-muted': variant === 'subtle' && ![true,'true'].includes($attrs['aria-pressed']),
        'rounded-none border-t-2': variant === 'subtle' && $attrs['aria-pressed'] !== undefined,
        'border-transparent': variant === 'subtle' && [false,'false'].includes($attrs['aria-pressed']),
        'border-theme-brand text-theme-brand': variant === 'subtle' && [true,'true'].includes($attrs['aria-pressed']),
        'bg-theme-brand text-white [-webkit-text-stroke:1.5px_rgb(75_85_99)] [paint-order:stroke_fill] enabled:hover:opacity-90':
          variant === 'cta',
        'border border-theme-danger text-theme-danger enabled:hover:bg-theme-danger/10':
          variant === 'danger',
        'bg-theme-danger text-[rgb(var(--theme-on-danger))] enabled:hover:bg-[rgb(var(--theme-danger-hover))]':
          variant === 'danger-primary',
        'ring-1 ring-inset ring-[rgb(var(--theme-control-border))] text-theme-text enabled:hover:bg-theme-background-elevated':
          variant === 'secondary',
        'border-0 bg-transparent text-theme-text-muted enabled:hover:text-theme-brand': variant === 'text',
        'border-0 bg-transparent text-theme-danger enabled:hover:underline': variant === 'danger-text',
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
      :wrap-label="wrapped"
    />
  </button>
</template>

<script setup>
import IconLabel from "./IconLabel.vue";
import { computed } from 'vue';

const props = defineProps({
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
      return ["subtle", "cta", "secondary", "text", "danger-text", "danger", "danger-primary", "success"].includes(value);
    },
  },
});
const wrapped = computed(() => props.wrapLabel || ['cta','secondary','text','danger-text','danger-primary'].includes(props.variant));
</script>
