<template>
  <!-- The single CTA look for the whole app: one component, fixed style
       (CustomButton variant="cta", full-width bar, centered label). Callers
       pass a label and an action — nothing that can diverge visually.
       `disabled` is behavioral state (form validity), not a style param.
       Layout attrs (type=submit, aria-*, class) fall through to the button. -->
  <CustomButton
    :label="label"
    variant="cta"
    :disabled="disabled"
    class="w-full"
    @click="callback?.()"
  />
</template>

<script setup>
import CustomButton from "./CustomButton.vue";

defineProps({
  label: { type: String, required: true },
  // The action. Optional for type=submit uses inside a form (the form's
  // submit handler owns the action; click and Enter both reach it).
  callback: { type: Function, default: undefined },
  disabled: { type: Boolean, default: false },
});
</script>
