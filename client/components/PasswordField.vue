<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <TextInput v-bind="$attrs" :id="id" :model-value="modelValue" type="password" reveal @update:model-value="$emit('update:modelValue', $event)" />
</template>
<script setup>
import TextInput from './TextInput.vue';
defineOptions({ inheritAttrs: false });
defineProps({ id: String, modelValue: String });
defineEmits(['update:modelValue']);
</script>
