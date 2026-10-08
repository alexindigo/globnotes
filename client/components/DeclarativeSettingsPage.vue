<!-- SPDX-License-Identifier: LGPL-3.0-only -->

<template>
  <div class="flex flex-col gap-4">
    <div
      v-if="blocking?.actions?.length"
      class="rounded border border-theme-warning px-3 py-2 text-sm"
      role="note"
    >
      <strong>Can block actions</strong>: {{ blocking.actions.join(", ") }}.
      Errors or timeouts in this plugin's guards also cancel the operation.
      <span v-if="!blocking.active">(currently inactive — plugin disabled)</span>
    </div>
    <p
      v-if="page.description"
      class="text-sm text-theme-text-muted"
    >{{ page.description }}</p>
    <section v-for="group in fieldGroups" :key="group.id" class="flex flex-col gap-4">
      <h3 v-if="group.label" class="font-semibold text-theme-text">{{ group.label }}</h3>
      <p v-if="group.description" class="text-sm text-theme-text-muted">{{ group.description }}</p>
      <SettingsField v-for="field in group.fields" :key="field.key" :field="field"
        :value="Object.hasOwn(snapshot.drafts,field.key)?snapshot.drafts[field.key]:snapshot.values[field.key]" :error="snapshot.errors[field.key]??''"
        :readonly="!snapshot.available || !snapshot.loaded || snapshot.writable===false" :on-browse="onBrowse"
        @edit="$emit('edit',$event)" @commit="$emit('commit',$event)" />
    </section>
    <p
      v-if="snapshot.status === 'saving'"
      class="text-xs text-theme-text-muted"
    >Saving…</p>
    <p
      v-else-if="snapshot.status === 'conflict'"
      class="text-xs text-theme-danger"
    >
      These settings changed elsewhere. Your edits were kept; reload to see
      the newer values (discards your pending edits) or keep editing.
      <button
        class="underline"
        @click="$emit('reload')"
      >Reload</button>
    </p>
    <p
      v-else-if="snapshot.status === 'error'"
      class="text-xs text-theme-danger"
    >{{ snapshot.message }} Your edit is kept. <button class="underline" :disabled="snapshot.pending || !snapshot.available || snapshot.writable===false" @click="$emit('retry')">Review / Retry</button></p>
    <div v-if="!snapshot.available" role="status">
      <p>This page is unavailable. Your draft is retained for recovery.</p>
      <pre tabindex="0">{{ JSON.stringify(snapshot.drafts, null, 2) }}</pre>
    </div>
    <div v-if="snapshot.changedDescriptor" role="status">
      <p>The page definition changed. Your original draft is retained; discard explicitly to load the new definition.</p>
      <pre tabindex="0">{{ JSON.stringify(snapshot.drafts, null, 2) }}</pre>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";

import SettingsField from "./SettingsField.vue";

const props = defineProps({
  page: { type: Object, required: true }, // declarative-v1 descriptor
  blocking: { type: Object, default: null },
  snapshot: { type: Object, required: true },
  onBrowse: Function,
});
defineEmits(["edit", "commit", "reload", "retry"]);

const visibleFields = computed(() =>
  (props.page.fields ?? []).filter((field) => {
    if (!field.visibleWhen) return true;
    return props.snapshot.values[field.visibleWhen.field] === field.visibleWhen.equals;
  }),
);
const fieldGroups=computed(()=>{
  const byKey=new Map(visibleFields.value.map(field=>[field.key,field])), assigned=new Set(), groups=[];
  for(const group of props.page.groups??[]){group.fields.forEach(key=>assigned.add(key));const fields=group.fields.map(key=>byKey.get(key)).filter(Boolean);if(fields.length)groups.push({...group,fields});}
  const remaining=visibleFields.value.filter(field=>!assigned.has(field.key));if(remaining.length)groups.push({id:'ungrouped',fields:remaining});return groups;
});

</script>
