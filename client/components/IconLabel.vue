<template>
  <div class="flex items-center" :class="{ 'icon-label-wrap': wrapLabel }">
    <Icon
      v-if="iconPath"
      :icon="iconPath"
      :size="iconSize"
      :class="[{ 'mr-1': label, 'shrink-0': wrapLabel }, iconClass]"
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
  wrapLabel: { type: Boolean, default: false },
});
</script>

<style scoped>
.icon-label-wrap {
  min-width: 0;
  max-width: 100%;
}
.icon-label-wrap > span {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
