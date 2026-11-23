<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <SettingsField :id="id" class="access-level-field" :field="{ key: id, label, description: help, type: 'select', options }" :value="value" :readonly="readonly" @edit="$emit('change', $event.raw)" />
</template>
<script setup>
import SettingsField from '../SettingsField.vue';
defineProps({ id: String, label: String, help: String, options: Array, value: String, readonly: Boolean });
defineEmits(['change']);
</script>
<style scoped>
.access-level-field :deep(.settings-field-select) { width: 10rem; }
</style>
