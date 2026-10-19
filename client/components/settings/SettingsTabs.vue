<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="settings-tabs-frame">
  <div v-if="pages.length >= 2" role="tablist" aria-label="Plugin settings pages" class="settings-tabs" @keydown="navigate">
    <button v-for="page in pages" :key="page.id" type="button" role="tab" class="focus-ring"
      :id="`${identity}-${page.id}`" :aria-controls="panelId" :aria-selected="page.id === selected" :tabindex="page.id === selected ? 0 : -1"
      :data-settings-tab-id="page.id" @click="onSelect(page.id)">{{ page.label }}</button>
  </div>
  <div :id="panelId" :role="pages.length >= 2 ? 'tabpanel' : undefined" :aria-labelledby="pages.length >= 2 ? `${identity}-${selected}` : undefined"><slot /></div>
  </div>
</template>
<script setup>
const props = defineProps({ pages:Array, selected:String, onSelect:Function });
import { createUuid } from '../../../shared/uuid.ts';
const identity = `settings-tabs-${createUuid()}`, panelId = `${identity}-panel`;
function navigate(event) {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll('[role=tab]')];
  const index = tabs.indexOf(event.target);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); tabs[next]?.focus();
  // Manual activation: Enter/Space uses the same guarded onSelect as a click.
}
</script>
<style scoped>
.settings-tabs { display:flex; flex-wrap:wrap; gap:0.5rem; }
.settings-tabs-frame { display:flex; flex-direction:column; gap:1.5rem; min-width:0; }
button { padding:0.375rem 0.75rem; font-size:14px; color:rgb(var(--theme-text-muted)); border-bottom:2px solid transparent; overflow-wrap:anywhere; min-width:0; }
button[aria-selected=true] { color:rgb(var(--theme-text)); border-color:rgb(var(--theme-brand)); }
</style>
