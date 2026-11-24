<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <form class="identity-setup flex min-w-0 flex-col gap-6" @submit.prevent="controller.finish">
    <header><h1 id="identity-setup-title" class="text-lg font-semibold">Set up globnotes</h1><p class="mt-2 text-sm">Create your account and choose who can use this vault.</p></header>
    <div class="setup-columns">
      <fieldset class="setup-visibility min-w-0" :disabled="!state.editable"><legend class="mb-4 whitespace-nowrap font-semibold">Who can see this vault?</legend>
        <p>You will be its Admin and can change this later.</p><h2 class="mt-4 whitespace-nowrap font-semibold">Everybody else</h2><p class="my-4">Visitors and people you have not added to this vault.</p>
        <label v-for="choice in identitySetupLevels" :key="choice.level" class="setup-choice" :class="{'setup-choice-on':state.everybody === choice.level}"><input type="radio" name="identity-everybody" :value="choice.level" :checked="state.everybody === choice.level" v-focus="state.everybody === choice.level" @change="controller.setField('everybody', choice.level)" /><span><span class="whitespace-nowrap font-semibold">{{ choice.label }}</span><span class="mt-1 block text-[13px]">{{ choice.help }}</span></span></label>
      </fieldset>
      <fieldset class="flex min-w-0 flex-col gap-4" :disabled="!state.editable"><h2 class="whitespace-nowrap font-semibold">Create your account</h2>
        <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingRow id="setup-login" label="Login name"><TextInput id="setup-login" variant="field" :model-value="state.username" autocomplete="username" required @update:model-value="controller.setField('username', $event)" /></SettingRow>
          <SettingRow id="setup-password" label="Password"><PasswordField id="setup-password" :model-value="state.password" autocomplete="new-password" required @update:model-value="controller.setField('password', $event)" /></SettingRow>
        </div>
        <SettingRow id="setup-authenticator" label="Use an authenticator" help="Optional: sign in with your password and a code." short><template #default="row"><Toggle :id="row.id" :is-on="state.totpEnabled" :aria-labelledby="row.labelledby" @click="controller.toggleAuthenticator" /></template></SettingRow>
        <AuthenticatorEnrollment v-if="state.totpEnabled" :state="state.enrollment" :code="state.totpCode" code-id="setup-authenticator-code" :copy-key="controller.copyKey" @update:code="controller.setField('totpCode', $event)" />
      </fieldset>
    </div>
    <p v-if="state.error" role="alert" class="text-theme-danger">{{ state.error }}</p>
    <CustomButton v-if="!state.busy" type="submit" variant="cta" label="Finish setup" class="mt-auto w-full" /><p v-else role="status">Finishing setup...</p>
  </form>
</template>
<script setup>
import { computed } from 'vue';
import TextInput from './TextInput.vue';
import PasswordField from './PasswordField.vue';
import CustomButton from './CustomButton.vue';
import Toggle from './Toggle.vue';
import SettingRow from './settings/SettingRow.vue';
import AuthenticatorEnrollment from './AuthenticatorEnrollment.vue';
import { identitySetupLevels } from '../setupFormState.js';
const props = defineProps({ controller:{type:Object,required:true} });
const state = computed(() => props.controller.state);
</script>
<style scoped>
.identity-setup { min-height:100%; font-size:14px; }
.setup-columns { display:grid; grid-template-columns:288px minmax(0,1fr); gap:24px; flex:1; }
.setup-visibility { border-right:1px solid rgb(var(--theme-border)); padding-right:24px; }
.setup-choice { display:grid; grid-template-columns:20px minmax(0,1fr); align-items:start; gap:8px; margin-bottom:8px; border:1px solid rgb(var(--theme-border)); border-radius:4px; padding:12px; }
.setup-choice input { margin-top:4px; accent-color:rgb(var(--theme-brand)); }
.setup-choice-on { border-color:rgb(var(--theme-brand)); background:rgb(var(--theme-background-elevated)); }
@media(max-width:700px) { .setup-columns { grid-template-columns:minmax(0,1fr); } .setup-visibility { border-right:0; padding-right:0; } }
</style>
