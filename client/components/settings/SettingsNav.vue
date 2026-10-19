<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <nav class="settings-nav" aria-label="Settings pages">
    <div v-if="attentionItems.length" class="settings-nav-group" data-settings-attention>
      <h3 class="attention-heading">Needs attention ({{ attentionItems.length }})</h3>
      <button v-for="item in attentionItems" :key="item.id" type="button" class="focus-ring attention-entry" :data-attention-id="item.id" @click="item.open()"><span aria-hidden="true">●</span> {{ item.label }}</button>
    </div>
    <div v-for="group in groups" :key="group.id" class="settings-nav-group">
      <h3>{{ group.label }}</h3>
      <button v-for="page in group.pages" :key="page.id" type="button" class="focus-ring"
        :aria-current="page.active ? 'page' : undefined" :data-settings-nav-id="page.id" @click="onSelect(page.target)">
        {{ page.label }}
      </button>
    </div>
  </nav>
</template>
<script setup>
defineProps({ groups: Array, onSelect: Function, attentionItems:{type:Array,default:()=>[]} });
</script>
<style scoped>
.settings-nav { flex-shrink:0; width:13rem; min-width:0; overflow-y:auto; padding:1rem 0; border-right:1px solid rgb(var(--theme-border)); }
.settings-nav-group + .settings-nav-group { margin-top:1rem; }
h3 { padding:0.25rem var(--settings-inline-inset,1rem); font-size:12px; font-weight:600; color:rgb(var(--theme-text-very-muted)); }
button { --focus-ring-offset:-4px; display:block; width:100%; padding:0.5rem var(--settings-inline-inset,1rem); text-align:left; font-size:14px; color:rgb(var(--theme-text-muted)); overflow-wrap:anywhere; }
.attention-heading { color:rgb(var(--theme-text)); }
.attention-entry, .attention-entry:hover { color:rgb(var(--theme-warning)); }
button:hover { color:rgb(var(--theme-brand)); }
button[aria-current] { color:rgb(var(--theme-text)); background:rgb(var(--theme-background-elevated)); box-shadow:inset 2px 0 rgb(var(--theme-brand)); }
@media(max-width:639px) { .settings-nav { width:100%; max-height:9rem; border-right:0; border-bottom:1px solid rgb(var(--theme-border)); padding:0.5rem 0; } }
</style>
