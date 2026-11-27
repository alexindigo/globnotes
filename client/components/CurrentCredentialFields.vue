<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
    <SettingRow v-if="!codeOnly" :id="`${id}-password`" label="Current password"><PasswordField :id="`${id}-password`" :model-value="state.currentPassword" autocomplete="current-password" required :disabled="state.locked" :aria-invalid="errorId ? state.activity.invalid?.currentPassword : undefined" :aria-describedby="state.activity.invalid?.currentPassword ? errorId : undefined" @update:model-value="setField('currentPassword', $event)" /></SettingRow>
    <SettingRow v-if="state.view?.totpEnabled" :id="`${id}-code`" label="Current authenticator code"><TextInput :id="`${id}-code`" variant="field" :model-value="state.currentTotp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required :disabled="state.locked" :aria-invalid="errorId ? state.activity.invalid?.currentTotp : undefined" :aria-describedby="state.activity.invalid?.currentTotp ? errorId : undefined" @update:model-value="setField('currentTotp', $event)" /></SettingRow>
  </div>
</template>
<script setup>
import PasswordField from './PasswordField.vue';
import TextInput from './TextInput.vue';
import SettingRow from './settings/SettingRow.vue';
defineProps({ state:{type:Object,required:true}, setField:Function, id:String, codeOnly:Boolean, errorId:String });
</script>
