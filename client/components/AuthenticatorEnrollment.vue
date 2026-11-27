<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="authenticator-enrollment">
    <p v-if="state.busy" role="status">Preparing your authenticator...</p>
    <p v-else-if="state.error" role="alert" class="text-theme-danger">{{ state.error }}</p>
    <template v-else-if="state.candidate">
      <img :src="state.candidate.qr" alt="Authenticator setup QR code" class="authenticator-qr" />
      <div class="flex min-w-0 flex-col gap-4">
        <p>Scan with your authenticator app, or enter this key manually.</p>
        <div class="min-w-0"><p>Manual key</p><p class="manual-key">{{ state.candidate.secret }}</p><CustomButton v-if="!state.copying" type="button" variant="secondary" :icon-path="tabCopy" label="Copy setup key" :disabled="locked" @click="copyKey" /><p v-else role="status">Copying setup key...</p><p v-if="state.feedback" role="status">{{ state.feedback }}</p></div>
        <SettingRow :id="codeId" label="Code from the new authenticator"><TextInput :id="codeId" :model-value="code" variant="field" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required :disabled="locked" :aria-invalid="errorId ? true : undefined" :aria-describedby="errorId" @update:model-value="$emit('update:code', $event)" /></SettingRow>
      </div>
    </template>
  </div>
</template>
<script setup>
import CustomButton from './CustomButton.vue';
import TextInput from './TextInput.vue';
import SettingRow from './settings/SettingRow.vue';
import { tabCopy } from '../icons.js';
defineProps({ state:{type:Object,required:true}, code:String, codeId:String, copyKey:Function, locked:Boolean, errorId:String });
defineEmits(['update:code']);
</script>
<style scoped>
.authenticator-enrollment { display:grid; grid-template-columns:224px minmax(0,1fr); gap:24px; align-items:center; font-size:13px; }
.authenticator-qr { width:224px; max-width:100%; }
.manual-key { overflow-wrap:anywhere; }
@media(max-width:600px) { .authenticator-enrollment { grid-template-columns:minmax(0,1fr); } }
</style>
