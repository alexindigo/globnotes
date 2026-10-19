<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <span class="theme-note" :style="theme.vars" aria-hidden="true">
    <span class="theme-note-heading">Aa Heading</span>
    <span>Body text</span>
    <span class="theme-note-links"><span>a link</span><span class="theme-note-tag">#tag</span></span>
    <span class="theme-note-code"><span>code</span>()</span>
  </span>
</template>
<script setup>
defineProps({theme:{type:Object,required:true}});
</script>
<style scoped>
.theme-note { display:flex; min-width:0; flex-direction:column; gap:0.5rem; padding:1rem; border:1px solid rgb(var(--theme-border)); border-radius:0.25rem; background:rgb(var(--theme-background)); color:rgb(var(--theme-text)); font-size:14px; font-weight:400; line-height:1.5; overflow-wrap:anywhere; }
.theme-note-heading { font-size:18px; font-weight:600; }
.theme-note-links { display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem; color:rgb(var(--theme-brand)); }
.theme-note-tag { border-radius:0.25rem; background:rgb(var(--theme-background-elevated)); padding:0 0.25rem; }
.theme-note-code { color:rgb(var(--theme-code-punctuation)); }
.theme-note-code > span { color:rgb(var(--theme-code-keyword)); }
</style>
