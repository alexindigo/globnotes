<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div ref="group" class="flex min-w-0 flex-col gap-8" data-appearance-settings role="radiogroup" aria-label="Theme for this browser">
    <button :ref="el=>tiles.set('system',el)" type="button" role="radio" data-theme-id="system" :aria-checked="selected==='system'" :aria-label="snapshot.system.label" :aria-describedby="systemDescriptionId" :tabindex="focused==='system'?0:-1" class="theme-tile focus-ring" :class="{'theme-tile-selected':selected==='system'}" @focus="focused='system'" @keydown="navigate($event,'system')" @click="onSelect('system')">
      <span class="theme-tile-face theme-system-pair"><ThemeNotePreview v-for="theme in snapshot.system.pair" :key="theme.id" :theme="theme" /></span>
      <span class="theme-tile-label"><span>{{ snapshot.system.label }}</span><span v-if="selected==='system'" aria-hidden="true">✓</span></span>
      <span :id="systemDescriptionId" class="text-[13px] text-theme-text-muted">Now showing {{ snapshot.system.nowShowing }}</span>
    </button>
    <div v-for="(family,index) in snapshot.families" :key="family.label" role="group" class="flex min-w-0 flex-col gap-3" :aria-labelledby="`${systemDescriptionId}-family-${index}`">
      <h3 :id="`${systemDescriptionId}-family-${index}`" class="text-sm font-semibold">{{ family.label }}</h3>
      <div class="theme-family-grid">
        <button v-for="theme in family.themes" :key="theme.id" :ref="el=>tiles.set(theme.id,el)" type="button" role="radio" :data-theme-id="theme.id" :aria-label="theme.label" :aria-checked="selected===theme.id" :tabindex="focused===theme.id?0:-1" class="theme-tile focus-ring" :class="{'theme-tile-selected':selected===theme.id}" @focus="focused=theme.id" @keydown="navigate($event,theme.id)" @click="onSelect(theme.id)">
          <span class="theme-tile-face"><ThemeNotePreview :theme="theme" /></span><span class="theme-tile-label"><span>{{ theme.variant }}</span><span v-if="selected===theme.id" aria-hidden="true">✓</span></span>
        </button>
      </div>
    </div>
  </div>
</template>
<script setup>
import {ref,watch} from 'vue';
import ThemeNotePreview from './settings/ThemeNotePreview.vue';
import {createUuid} from '../../shared/uuid.ts';
const systemDescriptionId=`theme-system-${createUuid()}`;
const props=defineProps({snapshot:{type:Object,required:true},selected:String,onSelect:{type:Function,required:true}});
const group=ref(null), tiles=new Map(), focused=ref(props.selected || 'system');
watch(()=>props.selected,id=>{focused.value=id;});
function navigate(event,id) {
  const ids=props.snapshot.ids, index=ids.indexOf(id);
  let next;
  if (['ArrowRight','ArrowDown'].includes(event.key)) next=ids[(index+1)%ids.length];
  if (['ArrowLeft','ArrowUp'].includes(event.key)) next=ids[(index-1+ids.length)%ids.length];
  if (event.key==='Home') next=ids[0];
  if (event.key==='End') next=ids.at(-1);
  if(next) {event.preventDefault();focused.value=next;tiles.get(next)?.focus();}
  if(['Enter',' '].includes(event.key)) {event.preventDefault();props.onSelect(id);}
}
</script>
<style scoped>
.theme-family-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(9rem,100%),1fr)); gap:1rem; }
.theme-tile { display:flex; flex-direction:column; gap:0.75rem; min-width:0; border-radius:0.25rem; text-align:left; padding:0.375rem; color:rgb(var(--theme-text)); }
.theme-tile-face { display:flex; width:100%; min-width:0; flex-direction:column; gap:0.5rem; border-radius:0.25rem; }
.theme-tile-selected > .theme-tile-face { outline:2px solid rgb(var(--theme-text)); outline-offset:2px; }
.theme-tile-label { display:flex; width:100%; align-items:baseline; justify-content:space-between; gap:0.5rem; font-size:14px; }
.theme-system-pair { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0; width:100%; }
</style>
