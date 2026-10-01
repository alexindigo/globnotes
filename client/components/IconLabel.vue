<template>
  <div class="flex items-center">
    <Icon
      v-if="iconPath"
      :icon="iconPath"
      :size="iconSize"
      :class="[{ 'mr-1': label }, iconClass]"
    ></Icon>
    <span v-if="label">{{ label }}</span>
  </div>
</template>

<script setup>
import Icon from "../components/Icon.vue";

defineProps({
  iconPath: { type: [Array, String] },
  iconSize: {
    type: String,
    default: "1.25em",
  },
  iconClass: {
    type: [String, Array, Object],
    default: "",
  },
  label: String,
});
</script>
