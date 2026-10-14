<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <div class="flex flex-col gap-1">
    <label
      class="text-sm font-medium text-theme-text"
      :for="`settings-field-${field.key}`"
    >{{ field.label }}</label>
    <p v-if="provenance?.source === 'environment'" class="text-xs text-theme-text-muted" role="note">Set by environment · Read-only</p>
    <output v-if="field.type === 'slider'" :for="`settings-field-${field.key}`" class="text-sm text-theme-text">{{ value }}</output>
    <p
      v-if="field.description"
      class="text-xs text-theme-text-muted"
    >{{ field.description }}</p>
    <Toggle
      v-if="field.type === 'toggle'"
      :id="`settings-field-${field.key}`"
      :is-on="Boolean(value)"
      :disabled="readonly"
      @click="change(!value)"
    />
    <input
      v-else-if="field.type === 'color'"
      :id="`settings-field-${field.key}`"
      type="color"
      class="h-8 w-16"
      :value="value"
      :disabled="readonly"
      @input="edit($event.target.value)"
      @change="change($event.target.value)"
    >
    <select
      v-else-if="field.type === 'select'"
      :id="`settings-field-${field.key}`"
      class="rounded border border-theme-border bg-theme-background px-2 py-1 text-theme-text"
      :value="JSON.stringify(value)"
      :disabled="readonly"
      @change="change(parseSelect($event.target.value))"
    >
      <option
        v-for="option in field.options ?? []"
        :key="JSON.stringify(option.value)"
        :value="JSON.stringify(option.value)"
      >{{ option.label }}</option>
    </select>
    <input
      v-else-if="field.type === 'number' || field.type === 'slider'"
      :id="`settings-field-${field.key}`"
      :type="field.type === 'slider' ? 'range' : 'number'"
      class="rounded border border-theme-border bg-theme-background px-2 py-1 text-theme-text"
      :value="value"
      :min="field.min"
      :max="field.max"
      :step="field.step"
      :readonly="readonly"
      :disabled="field.type === 'slider' && readonly"
      @input="edit($event.target.value)"
      @blur="commit"
      @keydown.enter.prevent="commit"
    >
    <textarea
      v-else-if="field.type === 'textarea'"
      :id="`settings-field-${field.key}`"
      class="rounded border border-theme-border bg-theme-background px-2 py-1 text-theme-text"
      :value="value"
      :maxlength="field.maxLength"
      :readonly="readonly"
      @input="edit($event.target.value)"
      @blur="commit"
      @keydown="textareaKeydown"
    />
    <TextInput
      v-else
      :id="`settings-field-${field.key}`"
      :model-value="String(value ?? '')"
      :maxlength="field.maxLength"
      :readonly="readonly"
      @update:model-value="edit"
      @blur="commit"
      @keydown.enter.prevent="commit"
    />
    <CustomButton v-if="(field.type==='file'||field.type==='folder')&&onBrowse" :label="field.type==='folder'?'Choose folder':'Choose file'" :disabled="readonly" @click="onBrowse(field)" />
    <p
      v-if="error"
      class="text-xs text-theme-danger"
    >{{ error }}</p>
  </div>
</template>

<script setup>
import TextInput from "./TextInput.vue";
import Toggle from "./Toggle.vue";
import CustomButton from "./CustomButton.vue";

const props = defineProps({
  field: { type: Object, required: true },
  value: { required: true },
  error: { type: String, default: "" },
  readonly: { type: Boolean, default: false },
  provenance: { type: Object, default: null },
  onBrowse: Function,
});
const emit = defineEmits(["edit", "commit"]);

function edit(raw) {
  if (!props.readonly) emit("edit", { key: props.field.key, raw });
}
function commit() {
  if (!props.readonly) emit("commit", props.field.key);
}
function change(raw) { edit(raw); commit(); }
function textareaKeydown(event) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
}
function parseSelect(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
</script>
