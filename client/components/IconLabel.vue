<template>
  <div class="flex items-center">
    <Icon
      v-if="iconPath"
      :icon="iconPath"
      :size="iconSize"
      :class="{ 'mr-1': label }"
    ></Icon>
    <span v-if="label">{{ label }}</span>
  </div>
</template>

<script setup>
import Icon from "../components/Icon.vue";

defineProps({
  iconPath: String,
  iconSize: {
    type: String,
    default: "1.25em",
  },
  label: String,
});
</script>
