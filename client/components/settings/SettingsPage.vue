<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="settings-page settings-text" data-settings-page>
    <header>
      <div class="settings-page-heading"><h2 class="settings-heading" data-settings-page-heading>{{ title }}</h2><StatusLine :message="status" class="settings-page-status settings-help text-theme-text-muted" data-settings-status /><slot name="action" /></div>
      <p v-if="description" class="settings-page-description">{{ description }}</p>
    </header>
    <slot name="tabs" />
    <slot />
  </section>
</template>
<script setup>
import StatusLine from '../StatusLine.vue';
defineProps({ title: String, description: String, status: { type: String, default: '' } });
</script>
<style scoped>
.settings-page { width:100%; min-width:0; display:flex; flex-direction:column; gap:1.5rem; color:rgb(var(--theme-text)); overflow-wrap:anywhere; }
.settings-page-heading { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:0.5rem 0; }
/* The title owns the existing separator; the zero-basis status adds no gap or
   intrinsic width, including when the action wraps onto its own row. */
h2 { font-size:18px; font-weight:600; margin-inline-end:1rem; }
.settings-page-status { flex:1 1 0; min-width:0; }
.settings-page-description { margin-top:0.5rem; font-size:14px; color:rgb(var(--theme-text-muted)); max-width:65ch; }
.settings-page :deep(pre) { white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; max-width:100%; }
</style>
