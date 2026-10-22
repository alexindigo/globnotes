<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="settings-section" :class="{ 'settings-section-warning': tone === 'warning' }" :aria-labelledby="title ? headingId : undefined">
    <div v-if="title || help || helpParagraphs.length" class="settings-section-intro">
      <h3 v-if="title" :id="headingId">{{ title }}</h3>
      <div v-if="helpParagraphs.length" class="settings-section-prose"><p v-for="(paragraph, index) in helpParagraphs" :key="index">{{ paragraph }}</p></div>
      <p v-else-if="help">{{ help }}</p>
    </div>
    <slot />
  </section>
</template>
<script setup>
import { createUuid } from '../../../shared/uuid.ts';
defineProps({ title:String, help:String, helpParagraphs:{type:Array,default:()=>[]}, tone:String });
const headingId = `settings-section-${createUuid()}`;
</script>
<style scoped>
.settings-section { min-width:0; display:flex; flex-direction:column; gap:1rem; }
h3 { font-size:14px; font-weight:600; }
p { font-size:13px; color:rgb(var(--theme-text-muted)); max-width:65ch; margin-top:0.25rem; }
.settings-section-prose { display:flex; flex-direction:column; gap:0.75rem; margin-top:0.25rem; }
.settings-section-prose p { margin-top:0; }
.settings-section-warning { padding:1rem; border:1px solid rgb(var(--theme-warning) / 0.5); border-radius:0.5rem; background:color-mix(in srgb, rgb(var(--theme-warning)) 4%, rgb(var(--theme-background))); }
.settings-section-warning .settings-section-intro { color:rgb(var(--theme-warning)); }
.settings-section-warning .settings-section-intro p { color:inherit; line-height:1.6; }
</style>
