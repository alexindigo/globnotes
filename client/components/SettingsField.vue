<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <SettingRow :id="`settings-field-${field.key}`" :label="field.label" :help="field.description" :error="error" :pin="pin || presentation.pin" :short="presentation.short">
    <template v-if="field.type === 'slider'" #value><output :for="`settings-field-${field.key}`">{{ value }}</output></template>
    <template #default="{ id, labelledby, describedby, invalid }">
      <Toggle v-if="field.type === 'toggle'" :id="id" :is-on="Boolean(value)" :disabled="readonly" :aria-labelledby="labelledby" :aria-describedby="describedby" :aria-invalid="invalid" @click="toggle" />
      <input v-else-if="field.type === 'color'" :id="id" type="color" class="focus-ring h-8 w-16" :value="value" :disabled="readonly" :aria-describedby="describedby" :aria-invalid="invalid" @input="edit($event.target.value)" @change="change($event.target.value)">
      <select v-else-if="field.type === 'select'" :id="id" class="settings-field-input focus-ring" :value="presentation.selected" :disabled="readonly" :aria-describedby="describedby" :aria-invalid="invalid" @change="select($event.target.value)">
        <option v-for="option in field.options ?? []" :key="JSON.stringify(option.value)" :value="JSON.stringify(option.value)">{{ option.label }}</option>
      </select>
      <TextInput v-else-if="field.type === 'number'" :id="id" type="number" class="max-w-24" :model-value="value" :min="field.min" :max="field.max" :step="field.step" :readonly="readonly"
        :aria-describedby="describedby" :aria-invalid="invalid" @update:model-value="edit" @blur="commit" @keydown.enter.prevent="commit" />
      <input v-else-if="field.type === 'slider'" :id="id" type="range" class="focus-ring w-full accent-theme-brand" :value="value" :min="field.min" :max="field.max" :step="field.step" :disabled="readonly"
        :aria-describedby="describedby" :aria-invalid="invalid" @input="edit($event.target.value)" @blur="commit" @keydown.enter.prevent="commit">
      <textarea v-else-if="field.type === 'textarea'" :id="id" class="settings-field-input focus-ring w-full" :value="value" :maxlength="field.maxLength" :readonly="readonly"
        :aria-describedby="describedby" :aria-invalid="invalid" @input="edit($event.target.value)" @blur="commit" @keydown.ctrl.enter.prevent="commit" @keydown.meta.enter.prevent="commit" />
      <div v-else class="settings-field-text">
        <TextInput :id="id" :model-value="presentation.text" :maxlength="field.maxLength" :readonly="readonly" :aria-describedby="describedby" :aria-invalid="invalid" @update:model-value="edit" @blur="commit" @keydown.enter.prevent="commit" />
        <CustomButton v-if="presentation.browseLabel && onBrowse" type="button" variant="secondary" :label="presentation.browseLabel" wrap-label :disabled="readonly" @click="onBrowse(field)" />
      </div>
    </template>
  </SettingRow>
</template>
<script setup>
import { computed } from 'vue';
import TextInput from './TextInput.vue';
import Toggle from './Toggle.vue';
import CustomButton from './CustomButton.vue';
import SettingRow from './settings/SettingRow.vue';
import { settingsFieldPresentation, createSettingsFieldIntents } from '../declarativeSettings.js';
const props = defineProps({ field:{ type:Object, required:true }, value:{ required:true }, error:String, readonly:Boolean, provenance:Object, pin:String, onBrowse:Function });
const emit = defineEmits(['edit','commit']);
const presentation = computed(() => settingsFieldPresentation(props.field, props.value, props.provenance));
const { edit, commit, change, toggle, select } = createSettingsFieldIntents(props, emit);
</script>
<style scoped>
.settings-field-input { min-width:0; max-width:100%; border:1px solid rgb(var(--theme-border)); border-radius:0.25rem; padding:0.375rem 0.5rem; background:rgb(var(--theme-background)); color:rgb(var(--theme-text)); font-size:14px; accent-color:rgb(var(--theme-brand)); }
.settings-field-text { display:flex; flex-wrap:wrap; align-items:stretch; gap:1rem; min-width:0; }
.settings-field-text > input { flex:1; min-width:min(8rem,100%); }
</style>
