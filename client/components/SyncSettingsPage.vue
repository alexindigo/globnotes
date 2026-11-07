<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="sync-settings" data-sync-settings>
    <p v-if="snapshot.notice" class="sync-settings__notice">{{ snapshot.notice }}</p>
    <p v-if="snapshot.loading && !snapshot.loaded" role="status">Loading sync settings...</p>
    <div v-if="snapshot.error" role="alert"><p>{{ snapshot.error }}</p><CustomButton v-if="!snapshot.busy" type="button" label="Retry reading" variant="text" @click="controller.refresh" /></div>
    <p v-if="snapshot.message" role="status" :aria-busy="snapshot.busy">{{ snapshot.message }}</p>
    <CustomButton v-if="snapshot.canReview" type="button" label="Review current state" variant="secondary" class="self-start" @click="controller.review" />
    <CustomButton v-if="snapshot.canDiscardChoice" type="button" label="Discard retained choice" variant="text" class="self-start" @click="controller.discard()" />
    <p v-if="snapshot.loaded && !snapshot.instances.length && !snapshot.stale">No sync set up.</p>
    <p v-if="snapshot.loaded && !snapshot.plugins.length">Install or enable a sync plugin in <button type="button" class="sync-settings__link" @click="onPlugins">Plugins</button>.</p>
    <CustomButton v-if="snapshot.canAdd && !snapshot.adding" type="button" label="Add" variant="secondary" class="self-start" @click="controller.startAdd" />
    <form v-if="snapshot.adding" class="sync-settings__add" aria-label="Add sync instance" @submit.prevent="controller.createInstance">
      <label for="sync-plugin">Sync plugin</label><select id="sync-plugin" :value="snapshot.plugin" @change="controller.editAdd('plugin',$event.target.value)"><option v-for="plugin in snapshot.plugins" :key="plugin.id" :value="plugin.id">{{ plugin.name }}</option></select>
      <label for="sync-label">Label</label><TextInput id="sync-label" :model-value="snapshot.label" @update:model-value="controller.editAdd('label',$event)" />
      <div class="sync-settings__actions"><CustomButton v-if="snapshot.canCreate" type="submit" label="Add instance" variant="cta" /><CustomButton v-if="!snapshot.busy && !snapshot.unknown" type="button" label="Cancel" variant="text" @click="onCancelAdd" /></div>
    </form>
    <DriverInstance v-for="instance in snapshot.instances" :key="instance.id" :instance="instance" :on-edit="controller.edit" :on-save="controller.save" :on-discard="onDiscard" :on-toggle="controller.toggle" :on-sync="controller.syncNow" :on-remove="controller.remove" :on-manage="onManage" :on-edit-key="controller.editKey" :on-save-key="controller.saveKey" :on-clear-key="controller.clearKey" :on-decision="controller.decision" />
  </div>
</template>
<script setup>
import CustomButton from './CustomButton.vue';
import TextInput from './TextInput.vue';
import DriverInstance from './settings/DriverInstance.vue';
defineProps({ snapshot:{type:Object,required:true}, controller:{type:Object,required:true}, onPlugins:Function, onManage:Function, onDiscard:Function, onCancelAdd:Function });
</script>
<style scoped>
.sync-settings { display:flex; flex-direction:column; gap:1rem; min-width:0; }
.sync-settings__notice { font-size:13px; overflow-wrap:anywhere; }
.sync-settings__add { display:grid; gap:.5rem; min-width:0; }
.sync-settings__add label { white-space:nowrap; font-size:14px; }
.sync-settings__add select { width:100%; min-width:0; padding:.5rem .75rem; border:1px solid rgb(var(--theme-border)); border-radius:.25rem; background:rgb(var(--theme-background)); color:rgb(var(--theme-text)); }
.sync-settings__add select:focus-visible, .sync-settings__link:focus-visible { outline:2px solid rgb(var(--theme-brand)); outline-offset:2px; }
.sync-settings__actions { display:flex; gap:1rem; align-items:center; margin-block-start:.5rem; }
.sync-settings__link { color:rgb(var(--theme-brand)); text-decoration:underline; }
</style>
