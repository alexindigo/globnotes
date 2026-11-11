<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="driver-secret" :aria-labelledby="`${field.id}-label`">
    <div class="driver-secret__heading"><label :id="`${field.id}-label`" :for="field.id" :title="field.label">{{ field.label }}</label><span>{{ field.set ? 'Set' : 'Not set' }}</span></div>
    <p v-if="field.description" :id="`${field.id}-help`">{{ field.description }}</p>
    <template v-if="editable">
      <TextInput :id="field.id" type="password" autocomplete="new-password" :model-value="field.input" :aria-describedby="field.description ? `${field.id}-help` : undefined" @update:model-value="onEdit($event)" />
      <div class="driver-secret__actions"><CustomButton v-if="field.canSave" type="button" label="Save key" variant="secondary" @click="onSave" /><CustomButton v-if="field.canClear" type="button" label="Clear" variant="text" @click="onClear" /></div>
    </template>
  </section>
</template>
<script setup>
import CustomButton from '../CustomButton.vue';
import TextInput from '../TextInput.vue';
defineProps({ field:{type:Object,required:true}, editable:Boolean, onEdit:Function, onSave:Function, onClear:Function });
</script>
<style scoped>
.driver-secret { display:grid; gap:.5rem; min-width:0; }
.driver-secret__heading, .driver-secret__actions { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
.driver-secret label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; min-width:0; }
.driver-secret__heading span, .driver-secret p { font-size:13px; }
.driver-secret p { max-width:65ch; }
</style>
