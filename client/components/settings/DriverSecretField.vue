<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="driver-secret" :aria-label="field.label">
    <SettingRow :id="field.id" :label="field.label" :as="editable ? 'control' : 'value'" :help="field.description" form>
      <template #value><span class="driver-secret__status">{{ field.set ? 'Set' : 'Not set' }}</span></template>
      <template #default="row"><TextInput v-if="editable" :id="row.id" variant="settings" type="password" autocomplete="new-password" :model-value="field.input" :aria-describedby="row.describedby" @update:model-value="onEdit($event)" /></template>
    </SettingRow>
    <template v-if="editable">
      <div class="driver-secret__actions"><CustomButton size="settings" v-if="field.canSave" type="button" label="Save key" variant="secondary" @click="onSave" /><CustomButton size="settings" v-if="field.canClear" type="button" label="Clear" variant="secondary" @click="onClear" /></div>
    </template>
  </section>
</template>
<script setup>
import CustomButton from '../CustomButton.vue';
import TextInput from '../TextInput.vue';
import SettingRow from './SettingRow.vue';
defineProps({ field:{type:Object,required:true}, editable:Boolean, onEdit:Function, onSave:Function, onClear:Function });
</script>
<style scoped>
.driver-secret { display:grid; gap:.5rem; min-width:0; }
.driver-secret__actions { display:flex; align-items:center; justify-content:flex-end; gap:1rem; flex-wrap:wrap; }
.driver-secret__status { font-size:13px; white-space:nowrap; }
</style>
