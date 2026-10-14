<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <Modal :model-value="!!request" name="plugin-permission-request" anchor="viewport-center" labelledby="permission-request-title" trap-focus :close-handler-override="onCancel">
    <section v-if="request" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="permission-request-title" class="text-lg font-semibold text-theme-text">Plugin access request</h2>
        <CustomButton label="Review later" :disabled="busy" @click="onCancel" />
      </div>
      <PluginPermissionPanel :plugin="plugin" :view="view" :busy="busy" :error="error" :has-server="hasServer" :writable="false"
        :on-master="()=>{}" :on-approve="()=>{}" :on-delete="()=>{}" />
      <p v-if="request.reason" class="text-sm text-theme-text">{{ request.reason }}</p>
      <p class="text-sm text-theme-text">Requested kind: <strong>{{ request.kind === 'imports' ? 'Remote-code imports' : 'Network data' }}</strong>. Request source revision {{ request.source.revision }}.</p>
      <div class="rounded border border-theme-border p-3" data-permission-request-choices>
        <h3 class="font-semibold text-theme-text">Choose scopes to approve</h3>
        <label v-for="scope in request.scopes" :key="key(scope)" class="mt-2 flex items-center gap-2 break-all text-sm text-theme-text">
          <input type="checkbox" :checked="choices.scopes.some(item=>key(item)===key(scope))" :disabled="busy || !writable" @change="onScope(scope,$event.target.checked)">
          {{ scope.type === 'all' ? 'All hosts and all ports — broad access' : scope.authority }}
        </label>
        <p v-if="request.scopes.some(scope=>scope.type==='all')" class="mt-2 text-sm text-theme-warning">All-host selection requires its own confirmation. You may instead approve a narrower exact host or host:port.</p>
        <form v-if="request.scopes.some(scope=>scope.type==='all')" class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="addNarrow">
          <input v-model="narrow" placeholder="Exact host[:port]" aria-label="Narrow requested approval" class="rounded border border-theme-border bg-theme-background p-2 text-theme-text" :disabled="busy || !writable">
          <CustomButton label="Select narrow host" :disabled="busy || !writable || !narrow" />
        </form>
        <p v-if="choices.scopes.length" class="mt-2 break-all text-xs text-theme-text-muted">Selected: {{ choices.scopes.map(scope=>scope.type==='all'?'All hosts':scope.authority).join(', ') }}.</p>
        <Toggle label="Allow network" :is-on="choices.allowNetwork" :disabled="busy || !writable" :aria-pressed="choices.allowNetwork" @click="onMaster(!choices.allowNetwork)" class="mt-2" />
        <p class="mt-1 text-xs text-theme-text-muted">This is a separate explicit choice. With it off, approval is stored but access stays inactive. Enabling restores the other currently requested remembered grants too.</p>
      </div>
      <p v-if="!writable" class="text-sm text-theme-warning">Read-only session: permission decisions are unavailable.</p>
      <div class="flex flex-wrap justify-end gap-2">
        <CustomButton label="Cancel" :disabled="busy" @click="onCancel" />
        <CustomButton label="Deny" :disabled="busy || !writable" @click="onDeny" />
        <CustomButton label="Approve selected request" variant="cta" :disabled="busy || !writable || !choices.scopes.length" @click="onApprove" />
      </div>
    </section>
  </Modal>
</template>
<script setup>
import { ref } from "vue";
import Modal from "./Modal.vue";
import CustomButton from "./CustomButton.vue";
import Toggle from "./Toggle.vue";
import PluginPermissionPanel from "./PluginPermissionPanel.vue";
const props = defineProps({ request: Object, plugin: Object, view: Object, choices: Object, busy: Boolean, error: String, hasServer: Boolean, writable: Boolean,
  onScope: { type: Function, required: true }, onMaster: { type: Function, required: true }, onApprove: { type: Function, required: true }, onDeny: { type: Function, required: true }, onCancel: { type: Function, required: true } });
const narrow = ref("");
const key = scope => scope.type === "all" ? "all" : `host:${scope.authority}`;
function addNarrow() { props.onScope({ type: "host", authority: narrow.value }, true); narrow.value = ""; }
</script>
