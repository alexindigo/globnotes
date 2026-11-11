<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <article class="driver-instance" :data-driver-id="instance.id" :aria-labelledby="`driver-title-${instance.id}`">
    <header class="driver-instance__header">
      <h3 :id="`driver-title-${instance.id}`" :title="instance.label">{{ instance.label }}</h3>
      <DriverStateChip class="driver-instance__state" :status="instance.status" :label="instance.stateLabel" />
      <span v-if="instance.attentionCount" class="driver-instance__count">{{ instance.attentionCount }} need attention</span>
      <Toggle v-if="instance.canToggle" :is-on="instance.enabled" :aria-label="`Sync ${instance.label}`" @click="onToggle(instance.id)" />
    </header>
    <p class="driver-instance__plugin">{{ instance.pluginName }}</p>
    <p v-if="instance.reasonLabel" role="status">{{ instance.reasonLabel }}</p>
    <p v-if="instance.lastSyncLabel">Last sync: {{ instance.lastSyncLabel }}</p>
    <p v-if="instance.retryLabel">{{ instance.retryLabel }}</p>
    <p v-if="instance.enabledDraftLabel" role="status">{{ instance.enabledDraftLabel }}</p>
    <p v-if="instance.conditionNotice" class="driver-instance__notice">{{ instance.conditionNotice }}</p>
    <p v-if="instance.missing" role="status">This instance is unavailable. Your draft is retained.</p>
    <p v-if="instance.schemaChanged" role="status">The driver definition changed. Your original draft is retained; discard it explicitly before using the new fields.</p>
    <p v-else-if="instance.changed" role="status">These settings changed elsewhere. Your edits are retained. Review current state before saving.</p>
    <div class="driver-instance__actions">
      <CustomButton v-if="instance.canSync" type="button" label="Sync now" variant="secondary" @click="onSync(instance.id)" />
      <CustomButton v-if="instance.permissionsPage" type="button" label="Review plugin access" variant="text" @click="onManage(instance.plugin)" />
      <CustomButton v-if="instance.canRemove" type="button" label="Remove" variant="danger-text" @click="onRemove(instance.id)" />
    </div>
    <section class="driver-instance__settings" aria-label="Instance settings">
      <template v-if="instance.editable">
        <SettingRow :id="`driver-label-${instance.id}`" label="Label" :error="instance.labelError" v-slot="row"><TextInput :id="row.id" :model-value="instance.label" maxlength="128" :aria-describedby="row.describedby" :aria-invalid="row.invalid" @update:model-value="onEdit(instance.id,'label',$event)" /></SettingRow>
        <SettingsField v-for="item in instance.fields" :key="item.field.key" :id="item.id" :field="item.field" :value="item.value" :error="item.error" @edit="onEdit(instance.id,$event.key,$event.raw)" />
      </template>
      <dl v-else class="driver-instance__values"><template v-for="item in instance.fields" :key="item.field.key"><dt :title="item.field.label">{{ item.field.label }}</dt><dd>{{ item.display }}</dd></template></dl>
      <div class="driver-instance__actions"><CustomButton v-if="instance.canSave" type="button" label="Save settings" variant="cta" @click="onSave(instance.id)" /><CustomButton v-if="instance.canDiscard" type="button" label="Discard edits" variant="text" @click="onDiscard(instance.id)" /></div>
    </section>
    <DriverSecretField v-for="field in instance.secrets" :key="field.key" :field="field" :editable="instance.editable" :on-edit="value=>onEditKey(instance.id,field.key,value)" :on-save="()=>onSaveKey(instance.id,field.key)" :on-clear="()=>onClearKey(instance.id,field.key)" />
    <section v-if="instance.attention?.held.length" class="driver-instance__attention" aria-label="Deleted here">
      <h4>{{ instance.attention.held.length }} files deleted here still exist on {{ instance.label }}</h4>
      <div v-if="instance.canDecide" class="driver-instance__actions"><CustomButton type="button" label="Restore all here" variant="secondary" @click="onDecision(instance.id,'held_restore')" /><CustomButton type="button" :label="`Delete all on ${instance.label}`" variant="danger-text" @click="onDecision(instance.id,'held_delete')" /></div>
      <ul><li v-for="item in instance.attention.held" :key="item.path"><span class="driver-instance__path" :title="item.path">{{ item.path }}</span><div v-if="instance.canDecide" class="driver-instance__actions"><CustomButton type="button" label="Restore here" variant="text" @click="onDecision(instance.id,'held_restore',[item.path])" /><CustomButton type="button" :label="`Delete on ${instance.label}`" variant="danger-text" @click="onDecision(instance.id,'held_delete',[item.path])" /></div></li></ul>
    </section>
    <section v-if="instance.attention?.remoteEmpty" class="driver-instance__attention" aria-label="Remote looks empty">
      <h4>{{ instance.label }} looks empty; nothing was deleted</h4>
      <ul><li v-for="item in instance.attention.remoteEmpty.files" :key="item.path"><span class="driver-instance__path" :title="item.path">{{ item.path }}</span></li></ul>
      <div v-if="instance.canDecide" class="driver-instance__actions"><CustomButton type="button" :label="`Delete these ${instance.attention.remoteEmpty.files.length} files here too`" variant="danger-text" @click="onDecision(instance.id,'remote_empty_delete')" /><CustomButton type="button" label="Upload them again" variant="secondary" @click="onDecision(instance.id,'remote_empty_upload')" /></div>
    </section>
    <section v-if="instance.attention?.issues.length" class="driver-instance__attention" aria-label="Files not synced"><h4>Files not synced</h4><ul><li v-for="(item,index) in instance.attention.issues" :key="index"><span class="driver-instance__path" :title="item.path">{{ item.path }}</span><span>{{ item.reason || item.code }}</span></li></ul></section>
    <p v-for="notice in instance.attentionNotices" :key="notice" role="status">{{ notice }}</p>
  </article>
</template>
<script setup>
import CustomButton from '../CustomButton.vue';
import TextInput from '../TextInput.vue';
import SettingsField from '../SettingsField.vue';
import Toggle from '../Toggle.vue';
import SettingRow from './SettingRow.vue';
import DriverSecretField from './DriverSecretField.vue';
import DriverStateChip from '../DriverStateChip.vue';
defineProps({ instance:{type:Object,required:true}, onEdit:Function, onSave:Function, onDiscard:Function, onToggle:Function, onSync:Function, onRemove:Function, onManage:Function, onEditKey:Function, onSaveKey:Function, onClearKey:Function, onDecision:Function });
</script>
<style scoped>
.driver-instance { display:grid; gap:.75rem; min-width:0; border-top:1px solid rgb(var(--theme-border)); padding-block:1.25rem; font-size:14px; }
.driver-instance p { max-width:65ch; }
.driver-instance__header { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem 1rem; min-width:0; }
.driver-instance__header h3 { font-weight:600; font-size:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.driver-instance__state, .driver-instance__count { white-space:nowrap; font-size:12px; }
.driver-instance__plugin { font-size:13px; }
.driver-instance__actions { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem 1rem; min-width:0; }
.driver-instance__settings { display:grid; gap:1rem; margin-block:.5rem; min-width:0; }
.driver-instance__notice, .driver-instance__attention { background:rgb(var(--theme-background-elevated)); border:1px solid rgb(var(--theme-border)); padding:1rem; border-radius:.25rem; }
.driver-instance__attention { display:grid; gap:.75rem; min-width:0; }
.driver-instance__attention h4 { font-weight:500; }
.driver-instance__attention ul { display:grid; gap:.75rem; min-width:0; }
.driver-instance__attention li { display:grid; gap:.25rem; min-width:0; }
.driver-instance__path, .driver-instance__values dt { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.driver-instance__values { display:grid; grid-template-columns:minmax(0,1fr); gap:.5rem; }
.driver-instance__values dd { overflow-wrap:anywhere; }
</style>
