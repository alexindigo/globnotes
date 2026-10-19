<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <article class="plugin-row" :class="{ 'plugin-row-expanded': row.expanded }" :data-plugin-inventory-id="row.id">
    <div class="plugin-row-heading">
      <component :is="row.hasServer ? 'button' : 'div'" :type="row.hasServer ? 'button' : undefined" class="plugin-row-disclosure" :class="{ 'focus-ring':row.hasServer }" :id="headerId"
        :aria-expanded="row.hasServer ? row.expanded : undefined" :aria-controls="row.hasServer ? regionId : undefined" :onClick="row.hasServer ? onExpand : undefined">
        <span class="plugin-row-chevron" aria-hidden="true"><svg v-if="row.hasServer" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ 'plugin-row-chevron-open':row.expanded }"><path d="m9 5 7 7-7 7" /></svg></span>
        <span class="plugin-row-copy">
          <span class="plugin-row-name-line"><span class="plugin-row-name">{{ row.name }}</span><span v-if="row.runsInBrowser" class="plugin-row-browser">Runs in browser</span></span>
          <span v-if="row.attention.length" class="plugin-row-attention"><span v-for="item in row.attention" :key="item.key" :class="{ 'text-theme-danger':item.tone === 'danger', 'text-theme-warning':item.tone === 'warning', 'text-theme-text-muted':item.tone === 'quiet' }">{{ item.text }}</span></span>
        </span>
      </component>
      <div class="plugin-row-actions">
        <div v-if="$slots.actions" class="plugin-row-action-lane"><slot name="actions" /></div>
        <div class="plugin-row-toggle-lane"><slot name="toggle" /></div>
      </div>
    </div>
    <p v-if="row.toggleNote" class="plugin-row-note">{{ row.toggleNote }}</p>
    <div v-if="$slots.recovery" class="plugin-row-recovery"><slot name="recovery" /></div>
    <div v-if="row.expanded" :id="regionId" role="region" :aria-labelledby="headerId" class="plugin-row-body"><slot /></div>
  </article>
</template>
<script setup>
import { createUuid } from '../../../shared/uuid.ts';
defineProps({ row:Object, onExpand:Function });
const identity = createUuid(), headerId = `plugin-heading-${identity}`, regionId = `plugin-region-${identity}`;
</script>
<style scoped>
.plugin-row { --plugin-row-line:1.75rem; display:grid; grid-template-columns:16px minmax(0,1fr); column-gap:0.5rem; padding-inline:var(--plugin-inline-inset,0.5rem); border-top:1px solid rgb(var(--theme-border)); min-width:0; font-size:14px; }
.plugin-row-expanded { background:rgb(var(--theme-background-elevated)); }
.plugin-row-heading { grid-column:1 / -1; display:grid; grid-template-columns:minmax(min-content,1fr) minmax(0,max-content); align-items:start; gap:1rem; padding-block:0.75rem; }
.plugin-row-disclosure { display:grid; grid-template-columns:16px minmax(0,1fr); align-items:start; text-align:left; gap:0.5rem; min-width:0; }
.plugin-row-chevron { display:flex; align-items:center; height:var(--plugin-row-line); color:rgb(var(--theme-text)); }
.plugin-row-chevron-open { transform:rotate(90deg); }
.plugin-row-copy { display:flex; min-width:0; flex-direction:column; }
.plugin-row-name-line { line-height:var(--plugin-row-line); }
.plugin-row-name { font-weight:600; color:rgb(var(--theme-text)); }
.plugin-row-browser { margin-inline-start:0.5rem; font-size:13px; color:rgb(var(--theme-text-muted)); }
.plugin-row-attention { display:flex; flex-wrap:wrap; gap:0.25rem 1rem; font-size:13px; }
.plugin-row-note { font-size:13px; color:rgb(var(--theme-text-muted)); }
.plugin-row-actions { display:flex; align-items:start; justify-content:flex-end; flex-wrap:nowrap; min-width:0; min-height:var(--plugin-row-line); gap:0.5rem; }
.plugin-row-action-lane, .plugin-row-toggle-lane { display:flex; align-items:center; min-height:var(--plugin-row-line); }
.plugin-row-action-lane { min-width:0; }
.plugin-row-toggle-lane { flex-shrink:0; }
.plugin-row-body, .plugin-row-note, .plugin-row-recovery { grid-column:2; min-width:0; }
.plugin-row-body { padding-block-end:1.5rem; }
.plugin-row-note { padding-block-end:0.5rem; }
@media(max-width:639px) { .plugin-row-heading { gap:0.5rem; } }
</style>
