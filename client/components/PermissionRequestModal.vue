<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <Modal :model-value="!!request" name="plugin-permission-request" anchor="dialog" scroll="content" labelledby="permission-request-title" trap-focus :close-handler-override="onCancel">
    <section v-if="request" class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div class="flex flex-col gap-2">
        <h2 id="permission-request-title" class="text-lg font-semibold text-theme-text">{{ presentation?.title }}</h2>
        <p v-if="request.reason" class="text-sm text-theme-text">{{ request.reason }}</p>
        <p class="max-w-[65ch] text-[13px] text-theme-text-muted">{{ presentation?.summary }}</p>
      </div>
      <div class="flex flex-col gap-4" data-permission-request-choices>
        <fieldset class="flex min-w-0 flex-col gap-3">
          <legend class="mb-3 text-sm font-semibold">Choose scopes to approve</legend>
          <label v-for="row in presentation?.scopes" :key="row.key" class="flex items-start gap-3 break-all text-sm text-theme-text">
            <input type="checkbox" class="focus-ring mt-1 accent-theme-brand" :checked="row.selected" :disabled="busy || !writable" @change="onScope(row.scope,$event.target.checked)">
            <span>{{ row.label }}</span>
          </label>
        </fieldset>
        <template v-if="presentation?.broad">
          <p class="max-w-[65ch] text-[13px] text-theme-warning">All-host selection requires its own confirmation. You may instead approve a narrower exact host or host:port.</p>
          <form class="flex flex-wrap items-end gap-2" @submit.prevent="onNarrowHost(narrowHostText)">
            <SettingRow id="permission-narrow-host" class="min-w-0 flex-1" label="Exact host[:port]" :error="narrowError" v-slot="row">
              <TextInput :model-value="narrowHostText" @update:model-value="onNarrowText" :id="row.id" :aria-describedby="row.describedby" :aria-invalid="row.invalid" :disabled="busy || !writable" />
            </SettingRow>
            <CustomButton type="submit" label="Select narrow host" variant="text" wrap-label :disabled="!presentation?.canNarrow" />
          </form>
        </template>
        <p v-if="presentation?.selectedText" class="break-all text-[13px] text-theme-text-muted">Selected: {{ presentation.selectedText }}.</p>
        <SettingRow label="Allow network" help="This is a separate explicit choice. With it off, approval is stored but access stays inactive. Enabling restores the other currently requested remembered grants too." short v-slot="row">
          <Toggle :id="row.id" :aria-labelledby="row.labelledby" :aria-describedby="row.describedby" :is-on="choices.allowNetwork" :disabled="busy || !writable" @click="onMaster()" />
        </SettingRow>
      </div>
      <p v-if="error" role="alert" class="text-[13px] text-theme-danger">{{ error }} Your choices are retained.</p>
      <p v-if="!writable" class="text-[13px] text-theme-warning">Read-only session: permission decisions are unavailable.</p>
      <SettingsActions class="mt-auto">
        <template #start><CustomButton type="button" label="Deny" variant="danger-text" wrap-label :disabled="busy || !writable" @click="onDeny" /></template>
        <template #end><CustomButton type="button" label="Review later" variant="secondary" wrap-label :disabled="busy" @click="onCancel" /><CustomButton type="button" label="Approve" variant="cta" wrap-label :disabled="!presentation?.canApprove" @click="onApprove" /></template>
      </SettingsActions>
    </section>
  </Modal>
</template>
<script setup>
import Modal from './Modal.vue';
import CustomButton from './CustomButton.vue';
import TextInput from './TextInput.vue';
import Toggle from './Toggle.vue';
import SettingsActions from './SettingsActions.vue';
import SettingRow from './settings/SettingRow.vue';
defineProps({request:Object,presentation:Object,choices:Object,busy:Boolean,error:String,narrowError:String,narrowHostText:{type:String,default:''},writable:Boolean,
  onNarrowText:{type:Function,required:true},onNarrowHost:{type:Function,required:true},onScope:{type:Function,required:true},onMaster:{type:Function,required:true},onApprove:{type:Function,required:true},onDeny:{type:Function,required:true},onCancel:{type:Function,required:true}});
</script>
