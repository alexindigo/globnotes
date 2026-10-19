<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="settings-section">
    <div v-if="title || help"><h3 v-if="title">{{ title }}</h3><p v-if="help">{{ help }}</p></div>
    <slot />
  </section>
</template>
<script setup>defineProps({ title:String, help:String });</script>
<style scoped>
.settings-section { min-width:0; display:flex; flex-direction:column; gap:1rem; }
h3 { font-size:14px; font-weight:600; }
p { font-size:13px; color:rgb(var(--theme-text-muted)); max-width:65ch; margin-top:0.25rem; }
</style>
