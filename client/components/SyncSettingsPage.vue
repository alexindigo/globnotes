<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="sync-settings" data-sync-settings>
    <p v-if="snapshot.notice" class="sync-settings__notice">{{ snapshot.notice }}</p>
    <p v-if="snapshot.loading && !snapshot.loaded" role="status">Loading sync settings...</p>
    <div v-if="snapshot.error" role="alert"><p>{{ snapshot.error }}</p><CustomButton size="settings" v-if="!snapshot.busy" type="button" label="Retry reading" variant="secondary" @click="controller.refresh" /></div>
    <p v-if="snapshot.message" role="status" :aria-busy="snapshot.busy">{{ snapshot.message }}</p>
    <CustomButton size="settings" v-if="snapshot.canReview" type="button" label="Review current state" variant="secondary" class="self-start" @click="controller.review" />
    <CustomButton size="settings" v-if="snapshot.canDiscardChoice" type="button" label="Discard retained choice" variant="secondary" class="self-start" @click="controller.discard()" />
    <p v-if="snapshot.loaded && !snapshot.instances.length && !snapshot.stale">No sync set up.</p>
    <p v-if="snapshot.loaded && !snapshot.plugins.length">Install or enable a sync plugin in <CustomButton size="settings" type="button" variant="secondary" label="Plugins" @click="onPlugins" /></p>
    <CustomButton size="settings" v-if="snapshot.canAdd && !snapshot.adding" type="button" label="Add" variant="secondary" class="self-start" @click="controller.startAdd" />
    <form v-if="snapshot.adding" class="sync-settings__add" aria-label="Add sync instance" @submit.prevent="controller.createInstance">
      <SettingsField v-for="field in snapshot.addFields" :key="field.key" :id="`sync-${field.key}`" :field="field" :value="snapshot[field.key]" form @edit="controller.editAdd($event.key,$event.raw)" />
      <SettingsActions><template #end><CustomButton size="settings" v-if="!snapshot.busy && !snapshot.unknown" type="button" label="Cancel" variant="secondary" @click="onCancelAdd" /><CustomButton size="settings" v-if="snapshot.canCreate" type="submit" label="Add instance" variant="cta" /></template></SettingsActions>
    </form>
    <DriverInstance v-for="instance in snapshot.instances" :key="instance.id" :instance="instance" :on-edit="controller.edit" :on-save="controller.save" :on-discard="onDiscard" :on-toggle="controller.toggle" :on-sync="controller.syncNow" :on-remove="controller.remove" :on-manage="onManage" :on-edit-key="controller.editKey" :on-save-key="controller.saveKey" :on-clear-key="controller.clearKey" :on-decision="controller.decision" />
  </div>
</template>
<script setup>
import CustomButton from './CustomButton.vue';
import SettingsField from './SettingsField.vue';
import SettingsActions from './SettingsActions.vue';
import DriverInstance from './settings/DriverInstance.vue';
defineProps({ snapshot:{type:Object,required:true}, controller:{type:Object,required:true}, onPlugins:Function, onManage:Function, onDiscard:Function, onCancelAdd:Function });
</script>
<style scoped>
.sync-settings { display:flex; flex-direction:column; gap:1rem; min-width:0; }
.sync-settings p { max-width:65ch; }
.sync-settings__notice { font-size:13px; overflow-wrap:anywhere; }
.sync-settings__add { display:flex; flex-direction:column; gap:1rem; min-width:0; }
</style>
