<template>
  <section class="conflict-version" :aria-label="label">
    <header class="conflict-version__header" data-conflict-version-header>
      <h2>{{ label }}</h2>
      <p class="conflict-version__path" :title="member.path">{{ member.path }}</p>
      <p class="conflict-version__metadata">{{ member.mediaType }} | {{ member.size }} bytes</p>
      <p class="conflict-version__hash" :title="member.version">Version: {{ member.version }}</p>
      <a :href="href" class="text-theme-brand hover:underline" @click="event => onOpen?.(event, href)">Open file</a>
    </header>
    <pre v-if="member.preview === 'text'" class="conflict-version__source" tabindex="0" :aria-label="`${label} source`">{{ member.content }}</pre>
    <p v-else class="conflict-version__unavailable">{{ unavailable[member.preview] }}</p>
  </section>
</template>
<script setup>
defineProps({ label: { type: String, required: true }, member: { type: Object, required: true }, href: String, onOpen: Function });
const unavailable = { binary: "Inline comparison is unavailable for this file type.", too_large: "This file is too large for inline comparison.", invalid_utf8: "This file does not contain valid UTF-8 text. Inline comparison is unavailable." };
</script>
<style scoped>
.conflict-version { display: grid; grid-template-rows: auto 1fr; min-width: 0; border: 1px solid rgb(var(--theme-border)); border-radius: .375rem; overflow: hidden; }
.conflict-version__header { display: grid; grid-template-rows: repeat(5, auto); gap: .5rem; padding: 1rem; background: rgb(var(--theme-background-elevated)); min-width: 0; font-size: .8rem; }
.conflict-version__header h2 { font-size: 1rem; font-weight: 600; white-space: nowrap; }
.conflict-version__path, .conflict-version__hash, .conflict-version__metadata { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conflict-version__path { font-weight: 500; }
.conflict-version__source { margin: 0; padding: 1rem; min-height: 12rem; max-height: 26rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .875rem; line-height: 1.6; color: rgb(var(--theme-text)); }
.conflict-version__unavailable { padding: 1rem; font-size: .875rem; }
</style>
