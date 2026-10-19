<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <section class="settings-page" data-settings-page>
    <header>
      <div class="settings-page-heading"><h2 data-settings-page-heading>{{ title }}</h2><slot name="action" /></div>
      <p v-if="description" class="settings-page-description">{{ description }}</p>
    </header>
    <slot name="tabs" />
    <slot />
  </section>
</template>
<script setup>
defineProps({ title: String, description: String });
</script>
<style scoped>
.settings-page { width:100%; max-width:42rem; min-width:0; display:flex; flex-direction:column; gap:1.5rem; color:rgb(var(--theme-text)); overflow-wrap:anywhere; }
.settings-page-heading { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:0.5rem 1rem; }
h2 { font-size:18px; font-weight:600; }
.settings-page-description { margin-top:0.5rem; font-size:14px; color:rgb(var(--theme-text-muted)); max-width:65ch; }
.settings-page :deep(pre) { white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; max-width:100%; }
</style>
