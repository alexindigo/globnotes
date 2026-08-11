<template>
  <div class="flex items-center">
    <!-- Full lockup (canonical: client/assets/brand/logo.svg) -->
    <span
      :class="{ 'hidden sm:block': props.responsive }"
      v-html="logoSvg"
    ></span>
    <!-- Icon only (small screens; canonical: client/assets/brand/icon.svg) -->
    <span
      v-if="props.responsive"
      class="sm:hidden"
      v-html="iconSvg"
    ></span>
  </div>
</template>

<script setup>
import iconSvg from "../assets/brand/icon.svg?raw";
import logoSvg from "../assets/brand/logo.svg?raw";

const props = defineProps({
  responsive: {
    type: Boolean,
    default: false,
  },
});
</script>
