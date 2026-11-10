<template>
  <div v-if="snapshot.visible" ref="root" class="sync-status" @keydown.esc.stop.prevent="close(true)" @focusout="leave">
    <button ref="trigger" type="button" class="sync-status__trigger focus-ring" :class="`sync-status__trigger--${snapshot.tone}`" :title="snapshot.label" :aria-label="snapshot.label" :aria-expanded="open" aria-controls="sync-status-panel" aria-haspopup="dialog" data-sync-status @click="toggle">
      <Icon :icon="snapshot.icon" size="1.25em" />
    </button>
    <section v-if="open" id="sync-status-panel" class="sync-status__panel" role="dialog" aria-labelledby="sync-status-title" tabindex="-1" ref="panel">
      <h2 id="sync-status-title">Sync</h2>
      <p v-if="snapshot.error" role="status">{{ snapshot.error }}</p>
      <ul>
        <li v-for="instance in snapshot.instances" :key="instance.id">
          <header><h3 :title="instance.label">{{ instance.label }}</h3><DriverStateChip :status="instance.status" :label="instance.stateLabel" /></header>
          <p class="sync-status__plugin">{{ instance.pluginName }}</p>
          <template v-if="instance.enabled && instance.failingLabel">
            <p v-if="instance.reasonLabel">{{ instance.reasonLabel }}</p>
            <p>Since {{ instance.failingLabel }}. {{ instance.retryLabel }}.</p>
          </template>
          <p v-else>Last sync: {{ instance.lastSyncLabel }}</p>
        </li>
      </ul>
      <button type="button" class="sync-status__settings focus-ring" @click="settings">Open Sync settings</button>
    </section>
  </div>
</template>
<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import DriverStateChip from "./DriverStateChip.vue";
const props=defineProps({snapshot:{type:Object,required:true},onSettings:{type:Function,required:true}});
const open=ref(false),root=ref(),trigger=ref(),panel=ref();
function close(restore=false) { open.value=false;if(restore) trigger.value?.focus(); }
async function toggle() { open.value=!open.value;if(open.value) { await nextTick();panel.value?.focus(); } }
// A null destination is not an outside focus move: some browsers do not focus
// pointer-pressed buttons. Let that trigger click, or outside pointerdown, own it.
function leave(event) { if(event.relatedTarget && !root.value?.contains(event.relatedTarget)) close(); }
function outside(event) { if(!root.value?.contains(event.target)) close(); }
function settings() { close();props.onSettings(); }
watch(() => props.snapshot.visible,value=>{if(!value)close();});
document.addEventListener("pointerdown",outside);
onBeforeUnmount(()=>document.removeEventListener("pointerdown",outside));
</script>
<style scoped>
.sync-status { flex-shrink:0; }
.sync-status__trigger { display:grid; place-items:center; width:2.25rem; height:2.25rem; border-radius:.25rem; color:rgb(var(--theme-text-muted)); }
.sync-status__trigger:hover, .sync-status__trigger[aria-expanded=true] { background:rgb(var(--theme-background-elevated)); }
.sync-status__trigger--active { color:rgb(var(--theme-brand)); }
.sync-status__trigger--danger { color:rgb(var(--theme-danger)); }
.sync-status__panel { position:absolute; inset-block-start:100%; inset-inline-end:0; z-index:30; width:min(23rem,100%); max-height:calc(100dvh - 5rem); overflow:auto; border:1px solid rgb(var(--theme-border)); border-radius:.25rem; padding:1rem; background:rgb(var(--theme-background)); color:rgb(var(--theme-text)); box-shadow:0 4px 16px rgb(0 0 0 / .12); font-size:13px; }
.sync-status__panel h2 { font-size:18px; font-weight:600; white-space:nowrap; }
.sync-status__panel:focus { outline:none; }
.sync-status__panel li { display:grid; gap:.4rem; padding-block:1rem; border-bottom:1px solid rgb(var(--theme-border)); }
.sync-status__panel header { display:flex; align-items:center; justify-content:space-between; gap:1rem; min-width:0; }
.sync-status__panel h3 { font-size:15px; font-weight:500; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sync-status__panel p { overflow-wrap:anywhere; }
.sync-status__plugin { font-size:12px; }
.sync-status__settings { display:block; margin-block-start:1rem; color:rgb(var(--theme-brand)); white-space:nowrap; }
.sync-status__settings:hover { text-decoration:underline; }
</style>
